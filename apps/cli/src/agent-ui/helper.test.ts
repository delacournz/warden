import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DriverError } from "@delacour/warden-e2e/driver/driver.types";
import type { SimdClient } from "@delacour/warden-e2e/driver/ios/simd-client";
import type { Result } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import {
	ensureHelper,
	type HelperDeps,
	helperStatus,
	type SpawnSpec,
	socketPathFor,
	stopHelper,
	sweepDeadHelpers,
} from "./helper";
import { readState, writeState } from "./state";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const refused: DriverError = { code: "E_HELPER_CRASHED", message: "ECONNREFUSED", retryable: true };

type Sim = {
	clock: { t: number };
	deps: HelperDeps;
	requests: string[];
	spawns: SpawnSpec[];
	kills: Array<[number, string]>;
	/** pids considered alive */
	alive: Set<number>;
	/** connect succeeds once true */
	up: { value: boolean };
	/** a spawn flips `up` after this many ms of fake time (undefined: never) */
	listenAfterMs: { value: number | undefined };
};

function sim(): Sim {
	const clock = { t: 1_000_000 };
	const up = { value: false };
	const alive = new Set<number>([111]);
	const requests: string[] = [];
	const spawns: SpawnSpec[] = [];
	const kills: Array<[number, string]> = [];
	const listenAfterMs: Sim["listenAfterMs"] = { value: 0 };
	let spawnedAt: number | undefined;
	const client = {
		request: async (op: string) => {
			requests.push(op);
			return { success: true, data: null };
		},
		close: async () => undefined,
	} as unknown as SimdClient;
	const deps: HelperDeps = {
		connect: async (): Promise<Result<SimdClient, DriverError>> => {
			if (spawnedAt !== undefined && listenAfterMs.value !== undefined && clock.t - spawnedAt >= listenAfterMs.value) {
				up.value = true;
			}
			return up.value ? { success: true, data: client } : { success: false, error: refused };
		},
		spawnDetached: (spec) => {
			spawns.push(spec);
			spawnedAt = clock.t;
			alive.add(4242);
			return { pid: 4242 };
		},
		pidAlive: (pid) => alive.has(pid),
		kill: (pid, signal) => {
			kills.push([pid, signal]);
			alive.delete(pid);
		},
		sleep: async (ms) => {
			clock.t += ms;
		},
		now: () => clock.t,
		pid: 111,
	};
	return { clock, deps, requests, spawns, kills, alive, up, listenAfterMs };
}

function setup(): { c: TestContext; s: Sim; socketPath: string; host: Parameters<typeof ensureHelper>[0] } {
	const s = sim();
	const c = testContext([], { now: () => s.clock.t });
	ctx = c;
	const socketPath = join(c.cwd, "simd", `${UDID}.sock`);
	return { c, s, socketPath, host: c };
}

describe("socketPathFor", () => {
	test("$WARDEN_HOME/simd/<udid>.sock when it fits a unix socket path; a short /tmp path otherwise", () => {
		expect(socketPathFor({ env: { WARDEN_HOME: "/home/u/.warden" } }, UDID)).toBe(`/home/u/.warden/simd/${UDID}.sock`);
		const deep = socketPathFor({ env: { WARDEN_HOME: `/var/${"x".repeat(80)}/.warden` } }, UDID);
		expect(Buffer.byteLength(deep)).toBeLessThan(104);
		expect(deep).toContain("wsimd-");
	});
});

describe("ensureHelper", () => {
	test("already listening: no spawn, no row left behind", async () => {
		const { s, socketPath, host, c } = setup();
		s.up.value = true;
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/warden-simd", deps: s.deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: false } });
		expect(s.spawns).toEqual([]);
		expect(c.db.getMeta(`simd_spawn:${UDID}`)).toBeUndefined();
	});

	test("nobody listening: unlinks the stale socket file, spawns detached with the daemon flags, records {pid, socket}", async () => {
		const { s, socketPath, host, c } = setup();
		mkdirSync(join(socketPath, ".."), { recursive: true });
		writeFileSync(socketPath, "stale");
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/warden-simd", deps: s.deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4242 } });
		expect(existsSync(socketPath)).toBe(false);
		expect(s.spawns).toHaveLength(1);
		expect(s.spawns[0]?.cmd).toEqual([
			"/h/warden-simd",
			"--udid",
			UDID,
			"--socket",
			socketPath,
			"--idle-timeout",
			"600",
		]);
		expect(s.spawns[0]?.logPath).toBe(join(c.cwd, "simd", `${UDID}.log`));
		expect(readState(c, UDID).helper).toEqual({ pid: 4242, socket: socketPath });
		expect(c.db.getMeta(`simd_spawn:${UDID}`)).toBeUndefined();
	});

	test("--idle-timeout follows the option", async () => {
		const { s, socketPath, host } = setup();
		await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", idleTimeout: "90s", deps: s.deps });
		expect(s.spawns[0]?.cmd.slice(-2)).toEqual(["--idle-timeout", "90"]);
	});

	test("a live row held by another spawner: waits for its socket instead of spawning", async () => {
		const { s, socketPath, host, c } = setup();
		c.db.setMeta(`simd_spawn:${UDID}`, JSON.stringify({ pid: 999, at: s.clock.t }));
		s.alive.add(999);
		let polls = 0;
		const connect = s.deps.connect;
		const deps: HelperDeps = {
			...s.deps,
			connect: async (path) => {
				polls += 1;
				if (polls === 4) s.up.value = true;
				return connect(path);
			},
		};
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: false } });
		expect(s.spawns).toEqual([]);
		expect(c.db.getMeta(`simd_spawn:${UDID}`)).toContain("999");
	});

	test("a row whose holder died (or hung > 15 s) is taken over", async () => {
		const dead = setup();
		dead.c.db.setMeta(`simd_spawn:${UDID}`, JSON.stringify({ pid: 999, at: dead.s.clock.t }));
		await ensureHelper(dead.host, UDID, { socketPath: dead.socketPath, helperPath: "/h/w", deps: dead.s.deps });
		expect(dead.s.spawns).toHaveLength(1);
		ctx?.cleanup();

		const hung = setup();
		hung.s.alive.add(999);
		hung.c.db.setMeta(`simd_spawn:${UDID}`, JSON.stringify({ pid: 999, at: hung.s.clock.t - 16_000 }));
		await ensureHelper(hung.host, UDID, { socketPath: hung.socketPath, helperPath: "/h/w", deps: hung.s.deps });
		expect(hung.s.spawns).toHaveLength(1);
	});

	test("never listens: engine_unavailable after 5 s, row released", async () => {
		const { s, socketPath, host, c } = setup();
		s.listenAfterMs.value = undefined;
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.code).toBe("engine_unavailable");
			expect(res.error.message).toContain("within 5000 ms");
		}
		expect(s.clock.t - 1_000_000).toBeGreaterThanOrEqual(5000);
		expect(c.db.getMeta(`simd_spawn:${UDID}`)).toBeUndefined();
	});

	test("the spawned helper dies at startup: fails fast with the log tail", async () => {
		const { s, socketPath, host, c } = setup();
		s.listenAfterMs.value = undefined;
		const spawn = s.deps.spawnDetached;
		const deps: HelperDeps = {
			...s.deps,
			spawnDetached: (spec) => {
				const out = spawn(spec);
				writeFileSync(spec.logPath, "dyld: Library not loaded\nAbort trap\n");
				s.alive.delete(out.pid);
				return out;
			},
		};
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res.success).toBe(false);
		if (!res.success)
			expect(res.error.message).toContain("exited before it was ready: dyld: Library not loaded | Abort trap");
		expect(s.clock.t - 1_000_000).toBeLessThan(1000);
		expect(c.db.getMeta(`simd_spawn:${UDID}`)).toBeUndefined();
	});

	test("a missing helper binary: engine_unavailable with the doctor hint, nothing spawned", async () => {
		const { s, socketPath, host } = setup();
		const res = await ensureHelper(host, UDID, { socketPath, deps: s.deps });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.code).toBe("engine_unavailable");
		expect(s.spawns).toEqual([]);
	});

	test("the previous holder finished between our failed connect and our claim: no second spawn, its socket is kept", async () => {
		const { s, socketPath, host } = setup();
		let calls = 0;
		const deps: HelperDeps = {
			...s.deps,
			connect: async () => {
				calls += 1;
				return calls === 1 ? { success: false, error: refused } : s.deps.connect(socketPath);
			},
		};
		s.up.value = true;
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: false } });
		expect(s.spawns).toEqual([]);
	});
});

describe("stopHelper", () => {
	test("nothing running: a no-op, and a dead record is forgotten", async () => {
		const { c, s, socketPath } = setup();
		writeState(c, UDID, { generation: 2, updatedAt: 0, helper: { pid: 777, socket: socketPath } });
		expect(await stopHelper(c, UDID, { deps: s.deps })).toEqual({ stopped: false, how: "none" });
		expect(readState(c, UDID).helper).toBeUndefined();
		expect(readState(c, UDID).generation).toBe(2);
		expect(await stopHelper(c, UDID, { deps: s.deps })).toEqual({ stopped: false, how: "none" });
	});

	test("sends shutdown and returns once the socket is gone", async () => {
		const { c, s, socketPath } = setup();
		mkdirSync(join(socketPath, ".."), { recursive: true });
		writeFileSync(socketPath, "");
		s.alive.add(4242);
		writeState(c, UDID, { generation: 0, updatedAt: 0, helper: { pid: 4242, socket: socketPath } });
		s.up.value = true;
		const request = s.deps.connect;
		const deps: HelperDeps = {
			...s.deps,
			connect: async (path) => {
				const got = await request(path);
				if (got.success) {
					const original = got.data.request.bind(got.data);
					got.data.request = (async (op: string) => {
						const reply = await original(op);
						rmSyncQuiet(socketPath);
						return reply;
					}) as SimdClient["request"];
				}
				return got;
			},
		};
		expect(await stopHelper(c, UDID, { deps })).toEqual({ stopped: true, how: "shutdown" });
		expect(s.requests).toEqual(["shutdown"]);
		expect(s.kills).toEqual([]);
		expect(readState(c, UDID).helper).toBeUndefined();
	});

	test("a helper that ignores shutdown is SIGTERMed after ≤ 2 s, and its socket file is removed", async () => {
		const { c, s, socketPath } = setup();
		mkdirSync(join(socketPath, ".."), { recursive: true });
		writeFileSync(socketPath, "");
		s.alive.add(4242);
		s.up.value = true;
		writeState(c, UDID, { generation: 0, updatedAt: 0, helper: { pid: 4242, socket: socketPath } });
		const outcome = await stopHelper(c, UDID, { deps: s.deps });
		expect(outcome).toEqual({ stopped: true, how: "sigterm" });
		expect(s.kills).toEqual([[4242, "SIGTERM"]]);
		expect(s.clock.t - 1_000_000).toBeLessThanOrEqual(2100);
		expect(existsSync(socketPath)).toBe(false);
		expect(readState(c, UDID).helper).toBeUndefined();
	});
});

describe("helperStatus + sweepDeadHelpers", () => {
	test("status reflects the record and the pid", () => {
		const { c, s, socketPath } = setup();
		expect(helperStatus(c, UDID, s.deps)).toEqual({ running: false, pid: null, socket: null });
		mkdirSync(join(socketPath, ".."), { recursive: true });
		writeFileSync(socketPath, "");
		s.alive.add(4242);
		writeState(c, UDID, { generation: 0, updatedAt: 0, helper: { pid: 4242, socket: socketPath } });
		expect(helperStatus(c, UDID, s.deps)).toEqual({ running: true, pid: 4242, socket: socketPath });
		s.alive.delete(4242);
		expect(helperStatus(c, UDID, s.deps).running).toBe(false);
	});

	test("removes sockets whose recorded pid is dead; leaves live ones and unrecorded ones", () => {
		const { c, s } = setup();
		const dir = join(c.cwd, "simd");
		mkdirSync(dir, { recursive: true });
		const dead = join(dir, "DEAD.sock");
		const live = join(dir, "LIVE.sock");
		const unknown = join(dir, "UNKNOWN.sock");
		for (const path of [dead, live, unknown]) writeFileSync(path, "");
		s.alive.add(2);
		writeState(c, "DEAD", { generation: 0, updatedAt: 0, helper: { pid: 1, socket: dead } });
		writeState(c, "LIVE", { generation: 0, updatedAt: 0, helper: { pid: 2, socket: live } });
		expect(sweepDeadHelpers(c, s.deps)).toEqual([dead]);
		expect(existsSync(dead)).toBe(false);
		expect(existsSync(live)).toBe(true);
		expect(existsSync(unknown)).toBe(true);
		expect(readState(c, "DEAD").helper).toBeUndefined();
		expect(readState(c, "LIVE").helper).toEqual({ pid: 2, socket: live });
	});
});

function rmSyncQuiet(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}
