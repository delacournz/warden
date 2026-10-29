import { randomBytes } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { type ConditionsUpdate, type ProxyHandle, type ProxyStats, type ProxyStatus, serveControl } from "./control";
import { decide } from "./decide";
import { Pipe } from "./pipe";
import { delayMs, NO_CONDITIONS, type ProxyConditions, type Rng } from "./shaping";

const LOOPBACK = "127.0.0.1";
const MAX_HEAD = 64 * 1024;
const REASONS: Record<number, string> = {
	400: "Bad Request",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

/** Something notable the proxy did; `https-status-as-reset` is the CONNECT fallback for a `status` fault. */
export type ProxyEvent =
	| { kind: "fault"; host: string; action: "status" | "reset" | "delay" | "blackhole"; note?: "https-status-as-reset" }
	| { kind: "loss"; outcome: "reset" | "stall"; host: string }
	| { kind: "offline"; mode: "refuse" | "blackhole" };

export type StartProxyOptions = {
	/** listen port; 0 (default) = random */
	port?: number;
	conditions?: Partial<ProxyConditions>;
	/** drives loss and jitter; default `Math.random` */
	rng?: Rng;
	now?: () => number;
	/** map the requested origin to where to actually connect (tests point fake hosts at local servers) */
	resolve?: (host: string, port: number) => { host: string; port: number };
	onEvent?: (event: ProxyEvent) => void;
	/** fixed control token (default random) */
	token?: string;
	/** called after `POST /shutdown` has closed the proxy (a detached entry exits here) */
	onShutdown?: () => void;
};

export type RunningProxy = {
	handle: ProxyHandle;
	conditions(): ProxyConditions;
	setConditions(update: ConditionsUpdate): void;
	stats(): ProxyStats;
	/** resolves once listeners and every open connection are closed */
	close(): Promise<void>;
};

type Target = { host: string; port: number };

type ParsedHead =
	| { kind: "connect"; target: Target }
	| { kind: "http"; target: Target; head: Buffer }
	| { kind: "bad"; reason: string };

function splitHostPort(authority: string, defaultPort: number): Target | undefined {
	const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(authority);
	if (!match) return undefined;
	const host = match[1] ?? match[2];
	if (!host) return undefined;
	return { host, port: match[3] ? Number(match[3]) : defaultPort };
}

/** Drop hop-by-hop headers and force `Connection: close`, so one request = one upstream connection. */
function rewriteHead(lines: string[], requestLine: string): Buffer {
	const kept = lines.filter((l) => !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(l));
	return Buffer.from(`${[requestLine, ...kept, "Connection: close"].join("\r\n")}\r\n\r\n`);
}

function parseHead(raw: string): ParsedHead {
	const [requestLine = "", ...headers] = raw.split("\r\n");
	const parts = requestLine.split(" ");
	const [method, uri, version] = parts;
	if (parts.length !== 3 || !method || !uri || !version) return { kind: "bad", reason: "malformed request line" };
	if (method === "CONNECT") {
		const target = splitHostPort(uri, 443);
		return target ? { kind: "connect", target } : { kind: "bad", reason: "bad CONNECT target" };
	}
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return { kind: "bad", reason: "not a proxy request (absolute URI expected)" };
	}
	if (url.protocol !== "http:") return { kind: "bad", reason: `unsupported scheme ${url.protocol}` };
	const target = { host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port ? Number(url.port) : 80 };
	return { kind: "http", target, head: rewriteHead(headers, `${method} ${url.pathname}${url.search} ${version}`) };
}

function respond(socket: Socket, code: number, body = ""): void {
	const reason = REASONS[code] ?? "Fault";
	socket.end(
		`HTTP/1.1 ${code} ${reason}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
	);
}

function swallow(socket: Socket): void {
	socket.on("error", () => {});
}

/** Hard close that sends RST where the runtime can, plain destroy otherwise. */
function reset(socket: Socket): void {
	if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
	else socket.destroy();
}

/**
 * Start a shaping forward proxy on loopback: plain-HTTP absolute-URI requests and HTTPS `CONNECT`
 * tunnels (bytes only, no TLS interception). Conditions can change at any time via `setConditions`
 * or the control channel in `handle`; new connections and the next slice of open ones follow.
 */
export async function startProxy(options: StartProxyOptions = {}): Promise<RunningProxy> {
	const rng = options.rng ?? Math.random;
	const now = options.now ?? Date.now;
	const token = options.token ?? randomBytes(16).toString("hex");
	let conditions: ProxyConditions = { ...NO_CONDITIONS, ...options.conditions };
	const stats: ProxyStats = { connections: 0, resets: 0, stalls: 0, faulted: 0, bytesUp: 0, bytesDown: 0 };
	const open = new Set<Socket>();
	const held = new Set<Socket>();
	const emit = options.onEvent ?? (() => {});

	function track(socket: Socket): void {
		open.add(socket);
		swallow(socket);
		socket.on("close", () => {
			open.delete(socket);
			held.delete(socket);
		});
	}

	function hold(socket: Socket): void {
		held.add(socket);
		stats.stalls += 1;
	}

	function tunnel(client: Socket, upstream: Socket, first: Buffer | undefined, rest: Buffer): void {
		const p = () => conditions.params;
		const up = new Pipe(client, upstream, {
			kbps: () => p().upKbps,
			delay: () => delayMs(p(), rng, 0.5),
			now,
			onBytes: (n) => {
				stats.bytesUp += n;
			},
		});
		const down = new Pipe(upstream, client, {
			kbps: () => p().downKbps,
			delay: () => delayMs(p(), rng, 0.5),
			now,
			onBytes: (n) => {
				stats.bytesDown += n;
			},
		});
		const teardown = () => {
			up.stop();
			down.stop();
			client.destroy();
			upstream.destroy();
		};
		if (first) up.push(first);
		up.push(rest);
		client.on("data", (c) => up.push(c));
		client.on("end", () => up.finish());
		client.on("close", teardown);
		upstream.on("data", (c) => down.push(c));
		upstream.on("end", () => down.finish());
		upstream.on("error", teardown);
		upstream.on("close", (hadError) => {
			if (hadError) teardown();
		});
		client.resume();
	}

	function openUpstream(client: Socket, target: Target, onReady: (upstream: Socket) => void): void {
		const where = options.resolve?.(target.host, target.port) ?? target;
		const upstream = connect({ host: where.host, port: where.port, allowHalfOpen: true });
		swallow(upstream);
		open.add(upstream);
		upstream.on("close", () => open.delete(upstream));
		upstream.once("connect", () => onReady(upstream));
		upstream.once("error", () => {
			if (!client.destroyed && !client.writableEnded) respond(client, 502);
		});
	}

	/** Apply the verdict for one request: reset, hold, answer with a status, or wait and `go`. */
	function admit(client: Socket, target: Target, isConnect: boolean, go: () => void): void {
		const verdict = decide(conditions, target.host, isConnect, rng);
		if (verdict.event) emit(verdict.event);
		if (verdict.count) stats[verdict.count] += 1;
		const { act } = verdict;
		if (act.kind === "reset") reset(client);
		else if (act.kind === "hold") hold(client);
		else if (act.kind === "status") setTimeout(() => respond(client, act.code), verdict.waitMs);
		else if (verdict.waitMs > 0) setTimeout(() => !client.destroyed && go(), verdict.waitMs);
		else go();
	}

	function onHead(client: Socket, raw: string, rest: Buffer): void {
		const parsed = parseHead(raw);
		if (parsed.kind === "bad") {
			respond(client, 400, parsed.reason);
			return;
		}
		admit(client, parsed.target, parsed.kind === "connect", () => {
			openUpstream(client, parsed.target, (upstream) => {
				if (parsed.kind === "connect") {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					tunnel(client, upstream, undefined, rest);
				} else {
					tunnel(client, upstream, parsed.head, rest);
				}
			});
		});
	}

	function onConnection(client: Socket): void {
		stats.connections += 1;
		track(client);
		const { offline } = conditions.params;
		if (offline) {
			emit({ kind: "offline", mode: offline });
			if (offline === "refuse") reset(client);
			else hold(client);
			return;
		}
		let buffered = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			const end = buffered.indexOf("\r\n\r\n");
			if (end < 0) {
				if (buffered.length > MAX_HEAD) {
					client.off("data", onData);
					respond(client, 400, "request head too large");
				}
				return;
			}
			client.off("data", onData);
			client.pause();
			onHead(client, buffered.subarray(0, end).toString("latin1"), buffered.subarray(end + 4));
		};
		client.on("data", onData);
	}

	const server: Server = createServer({ allowHalfOpen: true }, onConnection);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: LOOPBACK, port: options.port ?? 0 }, resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("netproxy: no listen address");

	function update(change: ConditionsUpdate): void {
		const before = conditions.params.offline;
		conditions = {
			params: change.params ?? conditions.params,
			faults: change.faults ?? conditions.faults,
		};
		if (before === "blackhole" && conditions.params.offline !== "blackhole") {
			for (const socket of [...held]) socket.destroy();
		}
		// like airplane mode: going offline cuts connections that are already up (keep-alive, open tunnels), it does not just refuse new ones
		if (before === undefined && conditions.params.offline !== undefined) {
			for (const socket of [...open]) socket.destroy();
		}
	}

	const status = (): ProxyStatus => ({ ...conditions, pid: process.pid, stats: { ...stats } });
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= (async () => {
			control.stop(true);
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			for (const socket of open) socket.destroy();
			await closed;
		})();
		return closing;
	};
	const control = serveControl(
		{ status, update, shutdown: () => void close().then(() => options.onShutdown?.()) },
		token,
		LOOPBACK
	);
	const controlPort = control.port;
	if (controlPort === undefined) throw new Error("netproxy: no control port");

	return {
		handle: { pid: process.pid, host: LOOPBACK, port: address.port, controlPort, token },
		conditions: () => conditions,
		setConditions: update,
		stats: () => ({ ...stats }),
		close,
	};
}
