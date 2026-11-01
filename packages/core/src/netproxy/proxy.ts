import { randomBytes } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { ConditionsUpdate } from "@delacour/warden-config/shaping";
import { NO_CONDITIONS, type ProxyConditions, proxyShaping, type Rng } from "@delacour/warden-config/shaping";
import { type ProxyHandle, type ProxyStats, type ProxyStatus, proxyControl } from "./control";
import { proxyDecider } from "./decide";
import { Pipe } from "./pipe";

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

/** Parses the head of a proxy request. */
export class ProxyHeadParser {
	parse(raw: string): ParsedHead {
		const [requestLine = "", ...headers] = raw.split("\r\n");
		const parts = requestLine.split(" ");
		const [method, uri, version] = parts;
		if (parts.length !== 3 || !method || !uri || !version) return { kind: "bad", reason: "malformed request line" };
		if (method === "CONNECT") {
			const target = this.splitHostPort(uri, 443);
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
		return {
			kind: "http",
			target,
			head: this.rewriteHead(headers, `${method} ${url.pathname}${url.search} ${version}`),
		};
	}

	private splitHostPort(authority: string, defaultPort: number): Target | undefined {
		const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(authority);
		if (!match) return undefined;
		const host = match[1] ?? match[2];
		if (!host) return undefined;
		return { host, port: match[3] ? Number(match[3]) : defaultPort };
	}

	/** Drop hop-by-hop headers and force `Connection: close`, so one request = one upstream connection. */
	private rewriteHead(lines: string[], requestLine: string): Buffer {
		const kept = lines.filter((l) => !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(l));
		return Buffer.from(`${[requestLine, ...kept, "Connection: close"].join("\r\n")}\r\n\r\n`);
	}
}

export const proxyHeadParser = new ProxyHeadParser();

/** Socket actions the proxy takes on a client. */
export class ProxySockets {
	respond(socket: Socket, code: number, body = ""): void {
		const reason = REASONS[code] ?? "Fault";
		socket.end(
			`HTTP/1.1 ${code} ${reason}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
		);
	}

	swallow(socket: Socket): void {
		socket.on("error", () => {});
	}

	/** Hard close that sends RST where the runtime can, plain destroy otherwise. */
	reset(socket: Socket): void {
		if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
		else socket.destroy();
	}
}

export const proxySockets = new ProxySockets();

/**
 * A shaping forward proxy on loopback: plain-HTTP absolute-URI requests and HTTPS `CONNECT`
 * tunnels (bytes only, no TLS interception). Conditions can change at any time via `setConditions`
 * or the control channel in `handle`; new connections and the next slice of open ones follow.
 */
export class ProxyServer {
	private readonly rng: Rng;
	private readonly now: () => number;
	private readonly token: string;
	private conditions: ProxyConditions;
	private readonly stats: ProxyStats = { connections: 0, resets: 0, stalls: 0, faulted: 0, bytesUp: 0, bytesDown: 0 };
	private readonly open = new Set<Socket>();
	private readonly held = new Set<Socket>();
	/** the origin host of each client socket that has sent its head, so a fault change can find its tunnels */
	private readonly hosts = new Map<Socket, string>();
	private readonly emit: (event: ProxyEvent) => void;
	private server: Server | undefined;
	private control: ReturnType<typeof proxyControl.serve> | undefined;
	private closing: Promise<void> | undefined;

	constructor(private readonly options: StartProxyOptions = {}) {
		this.rng = options.rng ?? Math.random;
		this.now = options.now ?? Date.now;
		this.token = options.token ?? randomBytes(16).toString("hex");
		this.conditions = { ...NO_CONDITIONS, ...options.conditions };
		this.emit = options.onEvent ?? (() => {});
	}

	async start(): Promise<RunningProxy> {
		const server: Server = createServer({ allowHalfOpen: true }, this.onConnection);
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: LOOPBACK, port: this.options.port ?? 0 }, resolve);
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("netproxy: no listen address");

		const control = proxyControl.serve(
			{
				status: this.status,
				update: this.update,
				shutdown: () => void this.close().then(() => this.options.onShutdown?.()),
			},
			this.token,
			LOOPBACK
		);
		this.control = control;
		const controlPort = control.port;
		if (controlPort === undefined) throw new Error("netproxy: no control port");

		return {
			handle: { pid: process.pid, host: LOOPBACK, port: address.port, controlPort, token: this.token },
			conditions: () => this.conditions,
			setConditions: this.update,
			stats: () => ({ ...this.stats }),
			close: this.close,
		};
	}

	private track(socket: Socket): void {
		this.open.add(socket);
		proxySockets.swallow(socket);
		socket.on("close", () => {
			this.open.delete(socket);
			this.held.delete(socket);
			this.hosts.delete(socket);
		});
	}

	private hold(socket: Socket): void {
		this.held.add(socket);
		this.stats.stalls += 1;
	}

	private tunnel(client: Socket, upstream: Socket, first: Buffer | undefined, rest: Buffer): void {
		const p = () => this.conditions.params;
		const up = new Pipe(client, upstream, {
			kbps: () => p().upKbps,
			delay: () => proxyShaping.delayMs(p(), this.rng, 0.5),
			now: this.now,
			onBytes: (n) => {
				this.stats.bytesUp += n;
			},
		});
		const down = new Pipe(upstream, client, {
			kbps: () => p().downKbps,
			delay: () => proxyShaping.delayMs(p(), this.rng, 0.5),
			now: this.now,
			onBytes: (n) => {
				this.stats.bytesDown += n;
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

	private openUpstream(client: Socket, target: Target, onReady: (upstream: Socket) => void): void {
		const where = this.options.resolve?.(target.host, target.port) ?? target;
		const upstream = connect({ host: where.host, port: where.port, allowHalfOpen: true });
		proxySockets.swallow(upstream);
		this.open.add(upstream);
		upstream.on("close", () => this.open.delete(upstream));
		upstream.once("connect", () => onReady(upstream));
		upstream.once("error", () => {
			if (!client.destroyed && !client.writableEnded) proxySockets.respond(client, 502);
		});
	}

	/** Apply the verdict for one request: reset, hold, answer with a status, or wait and `go`. */
	private admit(client: Socket, target: Target, isConnect: boolean, go: () => void): void {
		const verdict = proxyDecider.decide(this.conditions, target.host, isConnect, this.rng);
		if (verdict.event) this.emit(verdict.event);
		if (verdict.count) this.stats[verdict.count] += 1;
		const { act } = verdict;
		if (act.kind === "reset") proxySockets.reset(client);
		else if (act.kind === "hold") this.hold(client);
		else if (act.kind === "status") setTimeout(() => proxySockets.respond(client, act.code), verdict.waitMs);
		else if (verdict.waitMs > 0) setTimeout(() => !client.destroyed && go(), verdict.waitMs);
		else go();
	}

	private onHead(client: Socket, raw: string, rest: Buffer): void {
		const parsed = proxyHeadParser.parse(raw);
		if (parsed.kind === "bad") {
			proxySockets.respond(client, 400, parsed.reason);
			return;
		}
		this.hosts.set(client, parsed.target.host);
		this.admit(client, parsed.target, parsed.kind === "connect", () => {
			this.openUpstream(client, parsed.target, (upstream) => {
				if (parsed.kind === "connect") {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					this.tunnel(client, upstream, undefined, rest);
				} else {
					this.tunnel(client, upstream, parsed.head, rest);
				}
			});
		});
	}

	private readonly onConnection = (client: Socket): void => {
		this.stats.connections += 1;
		this.track(client);
		const { offline } = this.conditions.params;
		if (offline) {
			this.emit({ kind: "offline", mode: offline });
			if (offline === "refuse") proxySockets.reset(client);
			else this.hold(client);
			return;
		}
		let buffered = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			const end = buffered.indexOf("\r\n\r\n");
			if (end < 0) {
				if (buffered.length > MAX_HEAD) {
					client.off("data", onData);
					proxySockets.respond(client, 400, "request head too large");
				}
				return;
			}
			client.off("data", onData);
			client.pause();
			this.onHead(client, buffered.subarray(0, end).toString("latin1"), buffered.subarray(end + 4));
		};
		client.on("data", onData);
	};

	/** Cut established connections whose host is now governed by a fault it was not governed by before. */
	private cutChangedFaults(previous: ProxyConditions["faults"]): void {
		for (const [socket, host] of [...this.hosts]) {
			const now = proxyShaping.faultFor(this.conditions.faults, host);
			if (!now) continue;
			const was = proxyShaping.faultFor(previous, host);
			if (was && JSON.stringify(was) === JSON.stringify(now)) continue;
			socket.destroy();
		}
	}

	private readonly update = (change: ConditionsUpdate): void => {
		const before = this.conditions.params.offline;
		const previousFaults = this.conditions.faults;
		this.conditions = {
			params: change.params ?? this.conditions.params,
			faults: change.faults ?? this.conditions.faults,
		};
		if (before === "blackhole" && this.conditions.params.offline !== "blackhole") {
			for (const socket of [...this.held]) socket.destroy();
		}
		// like airplane mode: going offline cuts connections that are already up (keep-alive, open tunnels), it does not just refuse new ones
		if (before === undefined && this.conditions.params.offline !== undefined) {
			for (const socket of [...this.open]) socket.destroy();
		}
		// a fault applies per connection at open, so a tunnel that is already up (HTTP/2 keep-alive) would never see it
		this.cutChangedFaults(previousFaults);
	};

	private readonly status = (): ProxyStatus => ({
		...this.conditions,
		pid: process.pid,
		stats: { ...this.stats },
	});

	private readonly close = (): Promise<void> => {
		this.closing ??= (async () => {
			this.control?.stop(true);
			const server = this.server;
			const closed = new Promise<void>((resolve) => server?.close(() => resolve()));
			for (const socket of this.open) socket.destroy();
			await closed;
		})();
		return this.closing;
	};
}
