import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import { getProxyStatus, setProxyConditions } from "./control";
import { type ProxyEvent, type RunningProxy, startProxy } from "./proxy";
import { seededRng, shapingFromCondition } from "./shaping";

const FAKE_HOST = "api.test";

let upstream: ReturnType<typeof Bun.serve>;
let proxy: RunningProxy | undefined;
const extraServers: Server[] = [];

beforeEach(() => {
	upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const { pathname } = new URL(req.url);
			if (pathname.startsWith("/big/")) return new Response("x".repeat(Number(pathname.slice(5))));
			if (pathname === "/echo") return new Response(`got ${(await req.text()).length}`);
			return new Response("hello");
		},
	});
});

afterEach(async () => {
	await proxy?.close();
	proxy = undefined;
	upstream.stop(true);
	for (const server of extraServers.splice(0)) server.close();
});

async function start(options: Parameters<typeof startProxy>[0] = {}, toPort?: number): Promise<RunningProxy> {
	proxy = await startProxy({
		resolve: (_host, port) => ({ host: "127.0.0.1", port: toPort ?? (port === 80 ? (upstream.port ?? 0) : port) }),
		...options,
	});
	return proxy;
}

type Reply =
	| { status: number; body: string; ms: number }
	| { closed: true; ms: number }
	| { timeout: true; ms: number };

/** One raw proxy request over a fresh socket: resolves with the reply, a close with no reply, or a timeout. */
function request(
	running: RunningProxy,
	path: string,
	opts: { host?: string; method?: string; body?: string; timeoutMs?: number; onOpen?: (s: Socket) => void } = {}
): Promise<Reply> {
	const host = opts.host ?? FAKE_HOST;
	const t0 = performance.now();
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port: running.handle.port });
		let data = "";
		const done = (reply: Reply) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(reply);
		};
		const timer = setTimeout(() => done({ timeout: true, ms: performance.now() - t0 }), opts.timeoutMs ?? 5000);
		socket.on("error", () => done({ closed: true, ms: performance.now() - t0 }));
		socket.on("data", (c) => {
			data += c.toString("latin1");
		});
		socket.on("close", () => {
			const status = /^HTTP\/1\.1 (\d+)/.exec(data);
			const ms = performance.now() - t0;
			if (!status) return done({ closed: true, ms });
			done({ status: Number(status[1]), body: data.split("\r\n\r\n").slice(1).join("\r\n\r\n"), ms });
		});
		socket.on("connect", () => {
			opts.onOpen?.(socket);
			const body = opts.body ?? "";
			socket.write(
				`${opts.method ?? "GET"} http://${host}${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: ${body.length}\r\n\r\n${body}`
			);
		});
	});
}

function ok(reply: Reply): { status: number; body: string; ms: number } {
	if (!("status" in reply)) throw new Error(`no reply: ${JSON.stringify(reply)}`);
	return reply;
}

describe("forwarding", () => {
	test("forwards a plain HTTP absolute-URI request", async () => {
		const p = await start();
		const reply = ok(await request(p, "/"));
		expect(reply.status).toBe(200);
		expect(reply.body).toBe("hello");
	});

	test("rejects a request that is not a proxy request", async () => {
		const p = await start();
		const reply = ok(await requestRaw(p, "GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
		expect(reply.status).toBe(400);
	});

	test("tunnels CONNECT bytes without touching them", async () => {
		const echo = createServer((s) => s.pipe(s));
		extraServers.push(echo);
		await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
		const echoPort = (echo.address() as { port: number }).port;
		const p = await start({}, echoPort);
		const reply = await new Promise<string>((resolve) => {
			const s = connect({ host: "127.0.0.1", port: p.handle.port });
			let out = "";
			s.on("data", (c) => {
				out += c.toString();
				if (out.includes("ping-through-tunnel")) {
					s.destroy();
					resolve(out);
				}
			});
			s.on("connect", () => {
				s.write("CONNECT secure.test:443 HTTP/1.1\r\nHost: secure.test:443\r\n\r\n");
				setTimeout(() => s.write("ping-through-tunnel"), 50);
			});
		});
		expect(reply).toStartWith("HTTP/1.1 200 Connection Established");
		expect(reply).toContain("ping-through-tunnel");
	});
});

function requestRaw(running: RunningProxy, raw: string): Promise<Reply> {
	const t0 = performance.now();
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port: running.handle.port });
		let data = "";
		socket.on("error", () => resolve({ closed: true, ms: 0 }));
		socket.on("data", (c) => {
			data += c.toString();
		});
		socket.on("close", () => {
			const status = /^HTTP\/1\.1 (\d+)/.exec(data);
			resolve(status ? { status: Number(status[1]), body: data, ms: performance.now() - t0 } : { closed: true, ms: 0 });
		});
		socket.on("connect", () => socket.write(raw));
	});
}

describe("shaping", () => {
	test("latency is added at open and per chunk (request and response)", async () => {
		const p = await start({ conditions: { params: { latencyMs: 120 } } });
		const reply = ok(await request(p, "/"));
		// open (full RTT) + half on the request + half on the response
		expect(reply.ms).toBeGreaterThanOrEqual(220);
		expect(reply.ms).toBeLessThan(2000);
	});

	test("jitter stays within latency ± jitter and is seed-reproducible", async () => {
		const p = await start({ conditions: { params: { latencyMs: 100, jitterMs: 60 } }, rng: seededRng(7) });
		const reply = ok(await request(p, "/"));
		expect(reply.ms).toBeGreaterThanOrEqual(2 * 40 - 20);
		expect(reply.ms).toBeLessThan(2 * 160 + 500);
	});

	test("downKbps caps server to client throughput", async () => {
		const p = await start({ conditions: { params: { downKbps: 400 } } });
		// 20 KB at 400 kbps = 50 KB/s => ~400 ms
		const reply = ok(await request(p, "/big/20000"));
		expect(reply.body.length).toBeGreaterThanOrEqual(20000);
		expect(reply.ms).toBeGreaterThanOrEqual(300);
		expect(reply.ms).toBeLessThan(3000);
	});

	test("upKbps caps client to server throughput", async () => {
		const p = await start({ conditions: { params: { upKbps: 400 } } });
		const reply = ok(await request(p, "/echo", { method: "POST", body: "y".repeat(20000), timeoutMs: 8000 }));
		expect(reply.body).toBe("got 20000");
		expect(reply.ms).toBeGreaterThanOrEqual(300);
		expect(reply.ms).toBeLessThan(4000);
	});

	test("no cap is much faster than the capped transfer", async () => {
		const p = await start();
		const reply = ok(await request(p, "/big/20000"));
		expect(reply.ms).toBeLessThan(300);
	});

	test("live reconfig mid-stream speeds up an in-flight transfer", async () => {
		const p = await start({ conditions: { params: { downKbps: 160 } } });
		// 40 KB at 160 kbps = 20 KB/s => 2 s if left alone
		const pending = request(p, "/big/40000", { timeoutMs: 8000 });
		await Bun.sleep(250);
		const applied = await setProxyConditions(p.handle, { params: {} });
		expect(applied.success).toBe(true);
		const reply = ok(await pending);
		expect(reply.body.length).toBeGreaterThanOrEqual(40000);
		expect(reply.ms).toBeLessThan(1200);
	});

	test("loss: lossPct 100 never answers; lossPct 0 always does", async () => {
		const events: ProxyEvent[] = [];
		const p = await start({
			conditions: { params: { lossPct: 100 } },
			rng: seededRng(1),
			onEvent: (e) => events.push(e),
		});
		const replies = await Promise.all([1, 2, 3, 4, 5, 6].map(() => request(p, "/", { timeoutMs: 400 })));
		expect(replies.every((r) => !("status" in r))).toBe(true);
		expect(events.filter((e) => e.kind === "loss")).toHaveLength(6);
		await setProxyConditions(p.handle, { params: { lossPct: 0 } });
		expect(ok(await request(p, "/")).status).toBe(200);
	});

	test("loss outcomes follow the injected RNG", async () => {
		const run = async (seed: number): Promise<string[]> => {
			const events: ProxyEvent[] = [];
			const p = await startProxy({
				conditions: { params: { lossPct: 100 } },
				rng: seededRng(seed),
				onEvent: (e) => events.push(e),
			});
			for (let i = 0; i < 8; i++) await request(p, "/", { timeoutMs: 60 });
			await p.close();
			return events.flatMap((e) => (e.kind === "loss" ? [e.outcome] : []));
		};
		const a = await run(42);
		const b = await run(42);
		expect(a).toHaveLength(8);
		expect(a).toEqual(b);
		expect(new Set(a).size).toBe(2);
	});
});

describe("host faults", () => {
	const faults = [
		{ match: "*.fail.test", action: { kind: "status", code: 503 } },
		{ match: "reset.test", action: { kind: "reset" } },
		{ match: "slow.test", action: { kind: "delay", ms: 250 } },
		{ match: "hole.test", action: { kind: "blackhole" } },
	] as const;

	test("status fault answers plain HTTP with the code, other hosts pass", async () => {
		const p = await start({ conditions: { faults } });
		expect(ok(await request(p, "/", { host: "a.fail.test" })).status).toBe(503);
		expect(ok(await request(p, "/", { host: "api.test" })).status).toBe(200);
	});

	test("status fault on CONNECT falls back to a reset and says so", async () => {
		const events: ProxyEvent[] = [];
		const p = await start({ conditions: { faults }, onEvent: (e) => events.push(e) });
		const reply = await requestRaw(p, "CONNECT a.fail.test:443 HTTP/1.1\r\nHost: a.fail.test:443\r\n\r\n");
		expect("closed" in reply).toBe(true);
		expect(events).toContainEqual({
			kind: "fault",
			host: "a.fail.test",
			action: "status",
			note: "https-status-as-reset",
		});
	});

	test("reset fault closes without a reply", async () => {
		const p = await start({ conditions: { faults } });
		expect("closed" in (await request(p, "/", { host: "reset.test" }))).toBe(true);
	});

	test("delay fault adds time, then forwards", async () => {
		const p = await start({ conditions: { faults } });
		const reply = ok(await request(p, "/", { host: "slow.test" }));
		expect(reply.status).toBe(200);
		expect(reply.ms).toBeGreaterThanOrEqual(240);
	});

	test("blackhole fault accepts and never answers", async () => {
		const p = await start({ conditions: { faults } });
		const reply = await request(p, "/", { host: "hole.test", timeoutMs: 400 });
		expect("timeout" in reply).toBe(true);
	});

	test("faults replaced live", async () => {
		const p = await start({ conditions: { faults } });
		await setProxyConditions(p.handle, { faults: [] });
		expect(ok(await request(p, "/", { host: "a.fail.test" })).status).toBe(200);
	});
});

describe("offline", () => {
	test("refuse closes at once", async () => {
		const p = await start({ conditions: { params: { offline: "refuse" } } });
		const reply = await request(p, "/");
		expect("closed" in reply).toBe(true);
		expect(reply.ms).toBeLessThan(500);
	});

	test("blackhole accepts and never answers; going online destroys the held sockets", async () => {
		const p = await start({ conditions: { params: { offline: "blackhole" } } });
		expect("timeout" in (await request(p, "/", { timeoutMs: 300 }))).toBe(true);
		const held = request(p, "/", { timeoutMs: 3000 });
		await Bun.sleep(100);
		await setProxyConditions(p.handle, { params: {} });
		expect("closed" in (await held)).toBe(true);
		expect(ok(await request(p, "/")).status).toBe(200);
	});

	test("offline then online on a live listener", async () => {
		const p = await start();
		await setProxyConditions(p.handle, { params: { offline: "refuse" } });
		expect("closed" in (await request(p, "/"))).toBe(true);
		await setProxyConditions(p.handle, { params: {} });
		expect(ok(await request(p, "/")).status).toBe(200);
	});
});

describe("control channel", () => {
	test("status reports conditions, pid and counters", async () => {
		const p = await start({ conditions: { params: { latencyMs: 5 } } });
		await request(p, "/");
		const status = await getProxyStatus(p.handle);
		expect(status.success && status.data.params.latencyMs).toBe(5);
		expect(status.success && status.data.stats.connections).toBe(1);
		expect(status.success && status.data.pid).toBe(process.pid);
	});

	test("requires the token", async () => {
		const p = await start();
		const res = await fetch(`http://127.0.0.1:${p.handle.controlPort}/status`);
		expect(res.status).toBe(403);
		const wrong = await getProxyStatus({ ...p.handle, token: "nope" });
		expect(wrong.success).toBe(false);
	});

	test("rejects an invalid update", async () => {
		const p = await start();
		const bad = await setProxyConditions(p.handle, { params: { lossPct: 400 } });
		expect(bad.success).toBe(false);
		expect(p.conditions().params.lossPct).toBeUndefined();
	});

	test("binds loopback only", async () => {
		const p = await start();
		expect(p.handle.host).toBe("127.0.0.1");
	});

	test("close() ends open connections", async () => {
		const p = await start({ conditions: { params: { offline: "blackhole" } } });
		const held = request(p, "/", { timeoutMs: 3000 });
		await Bun.sleep(50);
		await p.close();
		expect("closed" in (await held)).toBe(true);
		proxy = undefined;
	});
});

describe("shapingFromCondition", () => {
	test("maps presets, custom and offline through the shared table", () => {
		expect(shapingFromCondition({ kind: "preset", preset: "3g" })).toMatchObject({
			downKbps: 780,
			upKbps: 330,
			latencyMs: 100,
		});
		expect(shapingFromCondition({ kind: "online" })).toMatchObject({ latencyMs: 0, downKbps: 0, lossPct: 0 });
		expect(shapingFromCondition({ kind: "custom", lossPct: 5 }).lossPct).toBe(5);
		expect(shapingFromCondition({ kind: "offline" })).toEqual({ offline: "refuse" });
	});

	test("0 kbps means unlimited", async () => {
		const p = await start({ conditions: { params: shapingFromCondition({ kind: "online" }) } });
		expect(ok(await request(p, "/big/20000")).ms).toBeLessThan(300);
	});
});
