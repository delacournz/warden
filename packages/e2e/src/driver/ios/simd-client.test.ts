import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { el, snapshotOf } from "../driver.testing";
import { connectSimd, type SimdClient, spawnSimd } from "./simd-client";
import { bunSpawn, type SimdSpawn } from "./simd-transport";

const FAKE = join(import.meta.dir, "../../../native/scripts/fake-simd.ts");

let dir: string;
let clients: SimdClient[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "simd-client-"));
});

afterEach(async () => {
	await Promise.all(clients.map((client) => client.close()));
	clients = [];
	rmSync(dir, { recursive: true, force: true });
});

/** Run the real fake helper script with `bun` instead of a `warden-simd` binary. */
function fakeSpawn(script: object): SimdSpawn {
	const path = join(dir, "script.json");
	writeFileSync(path, JSON.stringify(script));
	return (cmd) => bunSpawn([process.execPath, FAKE, "--script", path, ...cmd.slice(1)]);
}

async function start(script: object, extra: Partial<Parameters<typeof spawnSimd>[0]> = {}) {
	const lines: string[] = [];
	const result = await spawnSimd({
		helperPath: "fake-simd",
		udid: "UDID-1",
		spawn: fakeSpawn(script),
		log: (line) => lines.push(line),
		graceMs: 2000,
		...extra,
	});
	if (result.success) clients.push(result.data);
	return { result, lines };
}

async function started(script: object, extra: Partial<Parameters<typeof spawnSimd>[0]> = {}) {
	const { result, lines } = await start(script, extra);
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return { client: result.data, lines };
}

describe("spawnSimd handshake", () => {
	test("waits for ready and exposes it; udid is passed to the helper", async () => {
		const { client } = await started({});
		expect(client.ready.protocol).toBe(1);
		expect(client.ready.udid).toBe("UDID-1");
		expect(client.ready.hid.transport).toBe("fake");
	});

	test("passes --resources and extra args", async () => {
		let seen: readonly string[] = [];
		const inner = fakeSpawn({});
		await started(
			{},
			{
				resources: "/res",
				args: ["--hid", "indigo"],
				spawn: (cmd) => {
					seen = cmd;
					return inner(cmd);
				},
			}
		);
		expect(seen).toEqual(["fake-simd", "--udid", "UDID-1", "--resources", "/res", "--hid", "indigo"]);
	});

	test("a protocol mismatch is refused", async () => {
		const { result } = await start({ ready: { protocol: 2 } });
		expect(!result.success && result.error.code).toBe("E_INTERNAL");
		expect(!result.success && result.error.message).toContain("protocol 2");
	});

	test("no ready event → E_TIMEOUT", async () => {
		const { result } = await start({ ready: false }, { readyTimeoutMs: 150 });
		expect(!result.success && result.error.code).toBe("E_TIMEOUT");
	});

	test("fatal before ready maps the error (E_UNKNOWN_UDID → E_UNKNOWN_DEVICE)", async () => {
		const { result } = await start({
			fatal: { beforeReady: true, error: { code: "E_UNKNOWN_UDID", message: "no sim UDID-1" } },
		});
		expect(!result.success && result.error).toMatchObject({ code: "E_UNKNOWN_DEVICE", message: "no sim UDID-1" });
	});

	test("a helper that exits before ready → E_HELPER_CRASHED with its stderr", async () => {
		const { result } = await start({ exitBeforeReady: 4, stderr: ["dyld: Library not loaded"] });
		expect(!result.success && result.error).toMatchObject({ code: "E_HELPER_CRASHED", retryable: true });
		expect(!result.success && result.error.message).toContain("exit 4");
		expect(!result.success && result.error.message).toContain("dyld: Library not loaded");
	});

	test("a missing binary → E_HELPER_MISSING", async () => {
		const result = await spawnSimd({ helperPath: "/nonexistent/warden-simd", udid: "U" });
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
	});
});

describe("requests", () => {
	test("echo carries params, id/op and the timeout", async () => {
		const { client } = await started({ ops: { tap: { echo: true } } });
		const result = await client.request("tap", { x: 10, y: 20 }, { timeoutMs: 5000 });
		expect(result).toEqual({ success: true, data: { x: 10, y: 20, timeoutMs: 5000 } });
	});

	test("responses may arrive out of order and are matched by id", async () => {
		const { client } = await started({
			ops: { slow: { data: "slow", delayMs: 200 }, fast: { data: "fast" }, mid: { data: "mid", delayMs: 80 } },
		});
		const order: string[] = [];
		const track = async (op: string) => {
			const result = await client.request(op);
			order.push(op);
			return result;
		};
		const [slow, fast, mid] = await Promise.all([track("slow"), track("fast"), track("mid")]);
		expect(order).toEqual(["fast", "mid", "slow"]);
		expect([slow, fast, mid]).toEqual([
			{ success: true, data: "slow" },
			{ success: true, data: "fast" },
			{ success: true, data: "mid" },
		]);
	});

	test("a per-op timeout → retryable E_TIMEOUT; the client stays usable and ignores the late answer", async () => {
		const { client, lines } = await started({
			ops: { hang: { ignore: true }, late: { data: 1, delayMs: 150 }, ok: { data: "ok" } },
		});
		const hung = await client.request("hang", {}, { timeoutMs: 80 });
		expect(!hung.success && hung.error).toMatchObject({ code: "E_TIMEOUT", retryable: true });
		const late = await client.request("late", {}, { timeoutMs: 40 });
		expect(!late.success && late.error.code).toBe("E_TIMEOUT");
		await Bun.sleep(200);
		expect(await client.request("ok")).toEqual({ success: true, data: "ok" });
		expect(lines.some((line) => line.includes("unknown id"))).toBe(true);
	});

	test("error responses are mapped; unknown wire codes are E_INTERNAL", async () => {
		const { client } = await started({
			ops: {
				find: { error: { code: "E_NO_ELEMENT", message: "nothing there", retryable: false } },
				weird: { error: { code: "E_WEIRD", message: "??" } },
				unsupported: { error: { code: "E_UNSUPPORTED_TEXT", message: "é", detail: { rest: "é" } } },
			},
		});
		const find = await client.request("find");
		expect(!find.success && find.error).toMatchObject({ code: "E_NO_ELEMENT", retryable: false });
		const weird = await client.request("weird");
		expect(!weird.success && weird.error).toMatchObject({ code: "E_INTERNAL", detail: { wireCode: "E_WEIRD" } });
		const unsupported = await client.request("unsupported");
		expect(!unsupported.success && unsupported.error.detail).toEqual({ rest: "é" });
		const unknown = await client.request("nope");
		expect(!unknown.success && unknown.error.code).toBe("E_BAD_REQUEST");
	});

	test("known ops are validated and typed", async () => {
		const snap = snapshotOf([el("window", { children: [el("button", { id: "go" })] })]);
		const { client } = await started({
			ops: {
				snapshot: {
					data: { backend: "axbridge", screen: snap.screen, truncated: false, elements: snap.elements, ms: 30 },
				},
				settle: { data: { quiet: "maybe" } },
				elementAtPoint: { data: null },
			},
		});
		const snapshot = await client.request("snapshot", { interactiveOnly: true });
		expect(snapshot.success && snapshot.data.elements[0]?.children[0]?.identifier).toBe("go");
		const settle = await client.request("settle", { quietMs: 100, timeoutMs: 1000 });
		expect(!settle.success && settle.error.code).toBe("E_INTERNAL");
		expect(!settle.success && settle.error.message).toContain("settle");
		expect(await client.request("elementAtPoint", { x: 1, y: 1 })).toEqual({ success: true, data: null });
	});

	test("garbage lines from the helper are ignored", async () => {
		const { client, lines } = await started({ startup: ["not json", '{"event":"nope"}'], ops: { ok: { data: 1 } } });
		expect(await client.request("ok")).toEqual({ success: true, data: 1 });
		expect(lines.filter((line) => line.includes("ignoring line"))).toHaveLength(2);
	});
});

describe("events", () => {
	test("log events are forwarded to the logger and to subscribers", async () => {
		const { client, lines } = await started({
			ops: { snapshot: { data: null, emitLog: { level: "warn", message: "axbridge unavailable, using ax" } } },
		});
		const seen: string[] = [];
		const off = client.on("log", (event) => seen.push(`${event.level}:${event.message}:${event.op}`));
		await client.request("snapshot");
		expect(seen).toEqual(["warn:axbridge unavailable, using ax:snapshot"]);
		expect(lines).toContain("[simd] warn: axbridge unavailable, using ax");
		off();
		await client.request("snapshot");
		expect(seen).toHaveLength(1);
	});

	test("fatal mid-session fails in-flight requests with the mapped error and sticks", async () => {
		const { client } = await started({
			ops: { boom: { fatal: { code: "E_NOT_BOOTED", message: "simulator shut down" } }, ok: { data: 1 } },
		});
		const fatals: string[] = [];
		client.on("fatal", (error) => fatals.push(error.code));
		const result = await client.request("boom");
		expect(!result.success && result.error).toMatchObject({ code: "E_NOT_BOOTED", message: "simulator shut down" });
		expect(fatals).toEqual(["E_NOT_BOOTED"]);
		const after = await client.request("ok");
		expect(!after.success && after.error.code).toBe("E_NOT_BOOTED");
	});
});

describe("crash handling (stdio)", () => {
	test("crash mid-request → E_HELPER_CRASHED for every in-flight request, then one respawn on the next call", async () => {
		const { client, lines } = await started({
			stderr: ["fake: about to die"],
			dieAfter: { requests: 3, once: true, exitCode: 9 },
			ops: { ok: { data: "alive" }, slow: { data: 1, delayMs: 500 } },
		});
		const exits: Array<number | null> = [];
		client.on("exit", (exit) => exits.push(exit.exitCode));
		expect(await client.request("ok")).toEqual({ success: true, data: "alive" });
		const slow = client.request("slow", {}, { timeoutMs: 3000 });
		const doomed = client.request("ok", {}, { timeoutMs: 3000 });
		const [slowResult, doomedResult] = await Promise.all([slow, doomed]);
		for (const result of [slowResult, doomedResult]) {
			expect(!result.success && result.error).toMatchObject({ code: "E_HELPER_CRASHED", retryable: true });
		}
		expect(!doomedResult.success && doomedResult.error.message).toContain("exit 9");
		expect(!doomedResult.success && doomedResult.error.message).toContain("fake: about to die");
		expect(exits).toEqual([9]);

		expect(await client.request("ok")).toEqual({ success: true, data: "alive" });
		expect(lines.some((line) => line.includes("respawning helper (1/1)"))).toBe(true);
		expect(client.ready.protocol).toBe(1);
	});

	test("a second crash is not respawned again (budget of one)", async () => {
		const { client } = await started({ dieAfter: { requests: 1 }, ops: { ok: { data: 1 } } });
		const first = await client.request("ok");
		expect(!first.success && first.error.code).toBe("E_HELPER_CRASHED");
		const second = await client.request("ok");
		expect(!second.success && second.error.code).toBe("E_HELPER_CRASHED");
		const third = await client.request("ok");
		expect(!third.success && third.error.code).toBe("E_HELPER_CRASHED");
	});

	test("maxRespawns 0 never respawns", async () => {
		const { client } = await started({ dieAfter: { requests: 1 }, ops: { ok: { data: 1 } } }, { maxRespawns: 0 });
		await client.request("ok");
		const next = await client.request("ok");
		expect(!next.success && next.error.code).toBe("E_HELPER_CRASHED");
	});

	test("concurrent calls after a crash share one respawn", async () => {
		const { client } = await started({ dieAfter: { requests: 1, once: true }, ops: { ok: { data: 1 } } });
		await client.request("ok");
		const [a, b] = await Promise.all([client.request("ok"), client.request("ok")]);
		expect(a).toEqual({ success: true, data: 1 });
		expect(b).toEqual({ success: true, data: 1 });
	});
});

describe("close", () => {
	test("sends shutdown, reports an expected exit, and refuses further requests", async () => {
		const { client } = await started({});
		const exits: boolean[] = [];
		client.on("exit", (exit) => exits.push(exit.expected));
		await client.close();
		expect(exits).toEqual([true]);
		const after = await client.request("health");
		expect(!after.success && after.error.code).toBe("E_INTERNAL");
	});

	test("kills a helper that ignores shutdown and stdin close", async () => {
		const { client } = await started({ ops: { shutdown: { ignore: true } } }, { graceMs: 300 });
		const started_ = Date.now();
		await client.close();
		expect(Date.now() - started_).toBeLessThan(3000);
	});
});

describe("connectSimd (unix socket)", () => {
	type Handler = (line: string, write: (data: string) => void) => void;

	/** In-process fake helper daemon; every connection gets `ready` first. */
	function listen(onLine: Handler, opts: { readyChunks?: string[] } = {}) {
		const socketPath = join(dir, `simd-${Math.random().toString(36).slice(2)}.sock`);
		const connections: Array<{ end(): void }> = [];
		const received: string[] = [];
		const ready = `${JSON.stringify({
			event: "ready",
			protocol: 1,
			version: "fake",
			udid: "U",
			hid: { transport: "fake" },
			ax: { default: "axbridge", bridge: "available" },
			screen: { width: 390, height: 844, scale: 3 },
		})}\n`;
		const server = Bun.listen<{ buffer: string }>({
			unix: socketPath,
			socket: {
				open(socket) {
					socket.data = { buffer: "" };
					connections.push(socket);
					if (opts.readyChunks) for (const chunk of opts.readyChunks) socket.write(chunk);
					else socket.write(ready);
				},
				data(socket, chunk) {
					socket.data.buffer += new TextDecoder().decode(chunk);
					const lines = socket.data.buffer.split("\n");
					socket.data.buffer = lines.pop() ?? "";
					for (const line of lines) {
						received.push(line);
						onLine(line, (data) => socket.write(data));
					}
				},
			},
		});
		return { socketPath, server, connections, received, ready };
	}

	test("handshake, request and out-of-order answers over the socket", async () => {
		const held: Array<() => void> = [];
		const daemon = listen((line, write) => {
			const { id, op } = JSON.parse(line) as { id: string; op: string };
			const answer = () => write(`${JSON.stringify({ id, ok: true, data: op })}\n`);
			if (op === "first") held.push(answer);
			else {
				answer();
				for (const release of held.splice(0)) release();
			}
		});
		try {
			const result = await connectSimd({ socketPath: daemon.socketPath });
			if (!result.success) throw new Error(result.error.message);
			clients.push(result.data);
			expect(result.data.ready.udid).toBe("U");
			const order: string[] = [];
			const client = result.data;
			const track = async (op: string) => {
				const answer = await client.request(op);
				order.push(op);
				return answer;
			};
			const [first, second] = await Promise.all([track("first"), track("second")]);
			expect(order).toEqual(["second", "first"]);
			expect([first, second]).toEqual([
				{ success: true, data: "first" },
				{ success: true, data: "second" },
			]);
		} finally {
			daemon.server.stop(true);
		}
	});

	test("a ready event and responses split across chunks are reassembled", async () => {
		const daemon = listen(
			(line, write) => {
				const { id } = JSON.parse(line) as { id: string };
				const text = `${JSON.stringify({ id, ok: true, data: { quiet: true, waitedMs: 7 } })}\n`;
				write(text.slice(0, 9));
				setTimeout(() => write(text.slice(9)), 30);
			},
			{
				readyChunks: [
					`{"event":"rea`,
					`dy","protocol":1,"version":"f","udid":"U","hid":{"transport":"t"},`,
					`"ax":{"default":"ax","bridge":"missing"},"screen":{"width":1,"height":2,"scale":3}}\n`,
				],
			}
		);
		try {
			const result = await connectSimd({ socketPath: daemon.socketPath });
			if (!result.success) throw new Error(result.error.message);
			clients.push(result.data);
			expect(result.data.ready.ax.bridge).toBe("missing");
			expect(await result.data.request("settle", { quietMs: 1, timeoutMs: 5 })).toEqual({
				success: true,
				data: { quiet: true, waitedMs: 7 },
			});
		} finally {
			daemon.server.stop(true);
		}
	});

	test("the daemon closing the connection → E_HELPER_CRASHED, and the socket client does not respawn", async () => {
		const daemon = listen(() => undefined);
		try {
			const result = await connectSimd({ socketPath: daemon.socketPath });
			if (!result.success) throw new Error(result.error.message);
			clients.push(result.data);
			const inflight = result.data.request("hang", {}, { timeoutMs: 3000 });
			await Bun.sleep(30);
			for (const connection of daemon.connections) connection.end();
			const crashed = await inflight;
			expect(!crashed.success && crashed.error).toMatchObject({ code: "E_HELPER_CRASHED", retryable: true });
			const next = await result.data.request("ok");
			expect(!next.success && next.error.code).toBe("E_HELPER_CRASHED");
			expect(daemon.connections).toHaveLength(1);
		} finally {
			daemon.server.stop(true);
		}
	});

	test("close() only disconnects: no shutdown is sent to the shared daemon", async () => {
		const daemon = listen(() => undefined);
		try {
			const result = await connectSimd({ socketPath: daemon.socketPath });
			if (!result.success) throw new Error(result.error.message);
			await result.data.close();
			await Bun.sleep(30);
			expect(daemon.received).toEqual([]);
		} finally {
			daemon.server.stop(true);
		}
	});

	test("fatal over the socket maps the error", async () => {
		const daemon = listen((line, write) => {
			const { id } = JSON.parse(line) as { id: string };
			write(`${JSON.stringify({ event: "fatal", error: { code: "E_AX_UNAVAILABLE", message: "bridge died" } })}\n`);
			write(`${JSON.stringify({ id, ok: true, data: null })}\n`);
		});
		try {
			const result = await connectSimd({ socketPath: daemon.socketPath });
			if (!result.success) throw new Error(result.error.message);
			clients.push(result.data);
			const failed = await result.data.request("snapshot");
			expect(!failed.success && failed.error).toMatchObject({ code: "E_AX_UNAVAILABLE", retryable: true });
		} finally {
			daemon.server.stop(true);
		}
	});

	test("no socket → a driver error, not a throw", async () => {
		const result = await connectSimd({ socketPath: join(dir, "missing.sock") });
		expect(!result.success && result.error.code).toBe("E_HELPER_CRASHED");
	});
});
