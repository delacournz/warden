import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerErr } from "../dev-broker/broker.types";
import { type BrokerServer, serveBroker } from "../dev-broker/ipc";
import { type DevSessionRecord, writeDevSession } from "../dev-session";
import {
	brokerFor,
	devtoolsResume,
	devtoolsStatus,
	evalExpr,
	parseSince,
	queryConsole,
	readTree,
} from "./broker-client";

const dirs: string[] = [];
const servers: BrokerServer[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const alive = { isAlive: () => true };

type Stub = (method: string, params: unknown) => ReturnType<Parameters<typeof serveBroker>[1]>;

/** A temp WARDEN_HOME with one dev session per `udid` whose broker is `stub`. */
async function session(udid: string, stub: Stub, env?: Record<string, string>) {
	const home = env?.WARDEN_HOME ?? mkdtempSync(join(tmpdir(), "wbc-"));
	if (env === undefined) dirs.push(home);
	const served = await serveBroker(join(mkdtempSync(join(tmpdir(), "wbs-")), "b.sock"), stub);
	if (!served.success) throw new Error(served.error.message);
	servers.push(served.data);
	dirs.push(join(served.data.socketPath, ".."));
	const record: DevSessionRecord = {
		version: 1,
		leaseId: `lease-${udid}`,
		pid: process.pid,
		platform: "ios",
		deviceId: udid,
		port: 8081,
		metroUrl: "http://localhost:8081",
		logDir: "/logs",
		projectRoot: "/p",
		startedAt: "2026-10-27T00:00:00.000Z",
		brokerSocket: served.data.socketPath,
	};
	writeDevSession({ WARDEN_HOME: home }, record);
	return { env: { WARDEN_HOME: home }, record };
}

const statusData = { state: { phase: "attached", targetId: "t", deviceName: "sim" }, pid: 1, methods: [] };

describe("brokerFor", () => {
	test("returns a handle when the socket answers status", async () => {
		const { env } = await session("U1", async () => ({ success: true, data: statusData }));
		expect(await brokerFor(env, "U1", alive)).toBeDefined();
	});

	test("undefined for another udid, no socket, or a dead socket", async () => {
		const { env, record } = await session("U1", async () => ({ success: true, data: statusData }));
		expect(await brokerFor(env, "OTHER", alive)).toBeUndefined();
		writeDevSession(env, { ...record, brokerSocket: "/nonexistent/b.sock" });
		expect(await brokerFor(env, "U1", alive)).toBeUndefined();
		const { brokerSocket: _gone, ...bare } = record;
		writeDevSession(env, bare);
		expect(await brokerFor(env, "U1", alive)).toBeUndefined();
	});
});

describe("work functions", () => {
	test("queryConsole passes params and adds the jsonl path", async () => {
		const seen: unknown[] = [];
		const { env } = await session("U1", async (method, params) => {
			if (method === "status") return { success: true, data: statusData };
			seen.push(params);
			return { success: true, data: { lines: [{ ts: 1, level: "log", kind: "console", text: "hi" }], total: 5 } };
		});
		const result = await queryConsole({ env, udid: "U1" }, { grep: "hi", limit: 3 }, alive);
		expect(result).toEqual({
			success: true,
			data: { file: "/logs/console.jsonl", total: 5, lines: [{ ts: 1, level: "log", kind: "console", text: "hi" }] },
		});
		expect(seen).toEqual([{ grep: "hi", limit: 3 }]);
	});

	test("the only live session is used when no udid is given; two are ambiguous", async () => {
		const stub: Stub = async (method) =>
			method === "status" ? { success: true, data: statusData } : { success: true, data: { route: "(tabs)/home" } };
		const { env } = await session("U1", stub);
		const { readRoute } = await import("./broker-client");
		expect(await readRoute({ env }, alive)).toEqual({ success: true, data: { route: "(tabs)/home" } });
		await session("U2", stub, env);
		const both = await readRoute({ env }, alive);
		expect(!both.success && both.error.code).toBe("ambiguous_device");
		expect(!both.success && both.error.message).toContain("U2");
	});

	test("no session is devtools_unavailable with the way out", async () => {
		const home = mkdtempSync(join(tmpdir(), "wbc-"));
		dirs.push(home);
		const result = await evalExpr({ env: { WARDEN_HOME: home } }, { expression: "1" }, alive);
		expect(!result.success && result.error.code).toBe("devtools_unavailable");
		expect(!result.success && result.error.hint).toBe("start `warden dev`");
	});

	test("broker errors map: unavailable keeps its hint, eval_failed is the plain message", async () => {
		const { env } = await session("U1", async (method) => {
			if (method === "status") return { success: true, data: statusData };
			if (method === "resume") return brokerErr("devtools_unavailable", "yielded", "close DevTools");
			return brokerErr("eval_failed", "ReferenceError: boom");
		});
		const resumed = await devtoolsResume({ env, udid: "U1" }, alive);
		expect(!resumed.success && resumed.error).toMatchObject({ code: "devtools_unavailable", hint: "close DevTools" });
		const evaled = await evalExpr({ env, udid: "U1" }, { expression: "boom()" }, alive);
		expect(!evaled.success && evaled.error).toMatchObject({ code: "failed", message: "ReferenceError: boom" });
	});

	test("devtoolsStatus carries the session", async () => {
		const { env } = await session("U1", async () => ({ success: true, data: statusData }));
		const status = await devtoolsStatus({ env, udid: "U1" }, alive);
		expect(status.success && status.data.session.deviceId).toBe("U1");
	});

	test("readTree scales rects, cuts to max and reformats", async () => {
		const tree = {
			screen: "Home",
			lines: ["x"],
			truncated: false,
			components: [
				{ id: 0, name: "View", testID: "home", parent: null, rect: { x: 0, y: 0, width: 100, height: 50 } },
				{ id: 1, name: "Text", text: "Hi", parent: 0, rect: { x: 10, y: 10, width: 20, height: 10 } },
			],
		};
		const { env } = await session("U1", async (method) =>
			method === "status" ? { success: true, data: statusData } : { success: true, data: tree }
		);
		const result = await readTree({ env, udid: "U1" }, { pixelRatio: 3, max: 1 }, alive);
		expect(result.success && result.data.components).toEqual([
			{ id: 0, name: "View", testID: "home", parent: null, rect: { x: 0, y: 0, width: 300, height: 150 } },
		]);
		expect(result.success && result.data.truncated).toBe(true);
		expect(result.success && result.data.lines).toEqual(["View testID=home (0,0 300×150)"]);
	});
});

describe("parseSince", () => {
	test("durations count back from now; ISO is absolute; junk is a usage error", () => {
		expect(parseSince("30s", 100_000)).toEqual({ success: true, data: 70_000 });
		expect(parseSince("2h", 10_000_000)).toEqual({ success: true, data: 2_800_000 });
		expect(parseSince("2026-10-27T00:00:00Z", 0)).toEqual({ success: true, data: Date.parse("2026-10-27T00:00:00Z") });
		const bad = parseSince("soon", 0);
		expect(!bad.success && bad.error.code).toBe("usage");
	});
});
