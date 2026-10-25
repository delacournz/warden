import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Owner } from "@delacour/warden-core/types";
import type { DriverError } from "@delacour/warden-e2e/driver/driver.types";
import type { SimdClient } from "@delacour/warden-e2e/driver/ios/simd-client";
import type { Result } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import {
	type ConnectOptions,
	ensureHelper,
	type HelperDeps,
	helperStatus,
	ownerKey,
	SHUTDOWN_WAIT_MS,
	type SpawnSpec,
	type StartOutcome,
	type StartSignal,
	simdEnvKey,
	socketPathFor,
	stopHelper,
	sweepDeadHelpers,
	watchStart,
} from "./helper";
import { type HelperRecord, readState, writeState } from "./state";

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
	/** every `sleep` the code under test asked for */
	sleeps: number[];
	/** clients closed / connects tried, in total and since the spawn */
	closes: { count: number };
	connects: { total: number; afterSpawn: number };
	/** what a spawn returns as the child's stdout signal (undefined: a spawner without one, like an old helper's) */
	signal: { make: (() => StartSignal) | undefined };
	/** mtime of helper binaries by path */
	mtimes: Map<string, number>;
};

function sim(): Sim {
	const clock = { t: 1_000_000 };
	const up = { value: false };
	const alive = new Set<number>([111]);
	const requests: string[] = [];
	const spawns: SpawnSpec[] = [];
	const kills: Array<[number, string]> = [];
	const listenAfterMs: Sim["listenAfterMs"] = { value: 0 };
	const sleeps: number[] = [];
	const closes = { count: 0 };
	const connects = { total: 0, afterSpawn: 0 };
	const signal: Sim["signal"] = { make: undefined };
	const mtimes = new Map<string, number>();
	let spawnedAt: number | undefined;
	const client = {
		request: async (op: string) => {
			requests.push(op);
			if (op === "shutdown") up.value = false;
			return { success: true, data: null };
		},
		close: async () => {
			closes.count += 1;
		},
	} as unknown as SimdClient;
	const deps: HelperDeps = {
		connect: async (): Promise<Result<SimdClient, DriverError>> => {
			connects.total += 1;
			if (spawnedAt !== undefined) connects.afterSpawn += 1;
			if (spawnedAt !== undefined && listenAfterMs.value !== undefined && clock.t - spawnedAt >= listenAfterMs.value) {
				up.value = true;
			}
			return up.value ? { success: true, data: client } : { success: false, error: refused };
		},
		spawnDetached: (spec) => {
			spawns.push(spec);
			spawnedAt = clock.t;
			alive.add(4242);
			return { pid: 4242, ...(signal.make ? { signal: signal.make() } : {}) };
		},
		pidAlive: (pid) => alive.has(pid),
		kill: (pid, signal) => {
			kills.push([pid, signal]);
			alive.delete(pid);
		},
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.t += ms;
		},
		now: () => clock.t,
		pid: 111,
		mtime: (path) => mtimes.get(path),
	};
	return { clock, deps, requests, spawns, kills, alive, up, listenAfterMs, sleeps, closes, connects, signal, mtimes };
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
	test("the per-request timeout reaches the client: $WARDEN_SIMD_TIMEOUT or the option, a duration; none by default", async () => {
		const { s, socketPath, host } = setup();
		s.up.value = true;
		const seen: Array<ConnectOptions | undefined> = [];
		const deps: HelperDeps = {
			...s.deps,
			connect: async (path, options) => {
				seen.push(options);
				return s.deps.connect(path);
			},
		};
		expect((await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps })).success).toBe(true);
		expect(seen).toEqual([undefined]);
		seen.length = 0;
		host.env.WARDEN_SIMD_TIMEOUT = "60s";
		expect((await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps })).success).toBe(true);
		expect(seen).toEqual([{ defaultTimeoutMs: 60_000 }]);
		seen.length = 0;
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps, requestTimeout: "3s" });
		expect(res.success).toBe(true);
		expect(seen).toEqual([{ defaultTimeoutMs: 3000 }]);
	});

	test("an unparsable $WARDEN_SIMD_TIMEOUT is a usage error before anything connects", async () => {
		const { s, socketPath, host } = setup();
		s.up.value = true;
		host.env.WARDEN_SIMD_TIMEOUT = "soon";
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.message).toContain("WARDEN_SIMD_TIMEOUT");
		expect(s.connects.total).toBe(0);
	});

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
		expect(readState(c, UDID).helper).toEqual({ pid: 4242, socket: socketPath, env: simdEnvKey(c.env) });
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

	test("never listens: engine_unavailable after 15 s, the spawned child is SIGTERMed and forgotten, row released", async () => {
		const { s, socketPath, host, c } = setup();
		s.listenAfterMs.value = undefined;
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.code).toBe("engine_unavailable");
			expect(res.error.message).toContain("within 15000 ms");
		}
		expect(s.clock.t - 1_000_000).toBeGreaterThanOrEqual(15_000);
		expect(s.kills).toEqual([[4242, "SIGTERM"]]);
		expect(readState(c, UDID).helper).toBeUndefined();
		expect(c.db.getMeta(`simd_spawn:${UDID}`)).toBeUndefined();
	});

	test("a spawned child still starting after 5 s (listens at 7 s) is waited for, not abandoned (14-1)", async () => {
		const { s, socketPath, host, c } = setup();
		s.listenAfterMs.value = 7000;
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4242 } });
		expect(s.spawns).toHaveLength(1);
		expect(s.kills).toEqual([]);
		expect(readState(c, UDID).helper?.pid).toBe(4242);
	});

	test("a waiter keeps waiting past 5 s while a live spawn row says another caller is still starting (14-1)", async () => {
		const { s, socketPath, host, c } = setup();
		c.db.setMeta(`simd_spawn:${UDID}`, JSON.stringify({ pid: 999, at: s.clock.t }));
		s.alive.add(999);
		const connect = s.deps.connect;
		const deps: HelperDeps = {
			...s.deps,
			connect: async (path) => {
				if (s.clock.t - 1_000_000 >= 7000) s.up.value = true;
				return connect(path);
			},
		};
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: false } });
		expect(s.spawns).toEqual([]);
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
		const res = await ensureHelper(host, UDID, { socketPath, deps: { ...s.deps, exists: () => false } });
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

const timedOut: DriverError = {
	code: "E_TIMEOUT",
	message: "warden-simd sent no ready event within 2000 ms",
	retryable: true,
};

describe("ensureHelper: silence vs a busy helper (14-2)", () => {
	test("no socket file: spawns at once, without probing a socket that is not there", async () => {
		const { s, socketPath, host } = setup();
		s.signal.make = signalOf("up", { count: 0 });
		const res = await ensureHelper(host, UDID, {
			socketPath,
			helperPath: "/h/w",
			deps: { ...s.deps, socketExists: () => s.spawns.length > 0 },
		});
		expect(res).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4242 } });
		expect(s.connects.total - s.connects.afterSpawn).toBe(0);
		expect(s.sleeps).toEqual([]);
	});

	/** A resident helper (pid 777, recorded, socket file present) whose handshake times out while `busy()` holds. */
	function busyResident(busy: () => boolean) {
		const t = setup();
		t.s.alive.add(777);
		mkdirSync(join(t.socketPath, ".."), { recursive: true });
		writeFileSync(t.socketPath, "");
		writeState(t.c, UDID, { generation: 0, updatedAt: 0, helper: { pid: 777, socket: t.socketPath } });
		const events: string[] = [];
		const connect = t.s.deps.connect;
		const deps: HelperDeps = {
			...t.s.deps,
			connect: async (path): Promise<Result<SimdClient, DriverError>> => {
				if (t.s.alive.has(777) && busy()) {
					t.s.connects.total += 1;
					return { success: false, error: timedOut };
				}
				if (t.s.alive.has(777)) t.s.up.value = true;
				return connect(path);
			},
			spawnDetached: (spec) => {
				events.push("spawn");
				return t.s.deps.spawnDetached(spec);
			},
			kill: (pid, signal) => {
				events.push(`kill ${pid}`);
				t.s.deps.kill(pid, signal);
			},
		};
		return { ...t, deps, events };
	}

	test("a handshake timeout while the recorded pid is alive means busy: waited for, no second helper spawned", async () => {
		const { s, socketPath, host, deps, c } = busyResident(() => s.clock.t - 1_000_000 < 3000);
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: false } });
		expect(s.spawns).toEqual([]);
		expect(s.kills).toEqual([]);
		expect(existsSync(socketPath)).toBe(true);
		expect(readState(c, UDID).helper?.pid).toBe(777);
	});

	test("a helper still busy after 5 s is stopped (its recorded pid) before the one replacement is spawned", async () => {
		const { s, socketPath, host, deps, events, c } = busyResident(() => true);
		s.signal.make = signalOf("up", { count: 0 });
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4242 } });
		expect(events).toEqual(["kill 777", "spawn"]);
		expect(readState(c, UDID).helper?.pid).toBe(4242);
	});

	test("a busy helper whose command line cannot be read is not stopped, and no second helper is spawned beside it", async () => {
		const { s, socketPath, host, deps, c } = busyResident(() => true);
		const res = await ensureHelper(host, UDID, {
			socketPath,
			helperPath: "/h/w",
			deps: { ...deps, command: () => undefined },
		});
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.message).toContain("not starting a second one");
		expect(s.spawns).toEqual([]);
		expect(s.kills).toEqual([]);
		expect(existsSync(socketPath)).toBe(true);
		expect(readState(c, UDID).helper?.pid).toBe(777);
	});

	test("refused while the recorded pid is alive (no socket file): the record is dropped before spawning, never two records", async () => {
		const { s, socketPath, host, c } = setup();
		s.alive.add(777);
		writeState(c, UDID, { generation: 0, updatedAt: 0, helper: { pid: 777, socket: socketPath } });
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4242 } });
		expect(s.spawns).toHaveLength(1);
		expect(s.kills).toEqual([]);
		expect(readState(c, UDID).helper?.pid).toBe(4242);
	});
});

const agentA: Owner = { kind: "agent", sessionId: "A", cwd: "/w" };
const agentB: Owner = { kind: "agent", sessionId: "B", cwd: "/w" };

function lease(c: TestContext, owner: Owner): void {
	c.db.insertLease(
		{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner, ttlMs: 3_600_000 },
		c.now()
	);
}

/** A child stdout signal that already resolved to `outcome`; `detached.count` counts `detach()` calls. */
function signalOf(outcome: StartOutcome, detached: { count: number }): () => StartSignal {
	return () => ({
		up: Promise.resolve(outcome),
		detach: () => {
			detached.count += 1;
		},
	});
}

describe("ensureHelper: starting", () => {
	test("a helper that signals ready: one connect after the spawn, no polling, no sleep", async () => {
		const { s, socketPath, host } = setup();
		const detached = { count: 0 };
		s.signal.make = signalOf("up", detached);
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4242 } });
		expect(s.connects.afterSpawn).toBe(1);
		expect(s.sleeps).toEqual([]);
		expect(s.clock.t).toBe(1_000_000);
	});

	test("keepClient hands the connected client over, still open; otherwise the probe client is closed", async () => {
		const kept = setup();
		kept.s.signal.make = signalOf("up", { count: 0 });
		const keptRes = await ensureHelper(kept.host, UDID, {
			socketPath: kept.socketPath,
			helperPath: "/h/w",
			keepClient: true,
			deps: kept.s.deps,
		});
		expect(keptRes.success && keptRes.data.client !== undefined).toBe(true);
		expect(kept.s.closes.count).toBe(0);
		ctx?.cleanup();

		const dropped = setup();
		dropped.s.signal.make = signalOf("up", { count: 0 });
		const droppedRes = await ensureHelper(dropped.host, UDID, {
			socketPath: dropped.socketPath,
			helperPath: "/h/w",
			deps: dropped.s.deps,
		});
		expect(droppedRes.success && droppedRes.data.client).toBeUndefined();
		expect(dropped.s.closes.count).toBe(1);
	});

	test("keepClient on a helper that is already listening: the one connect is the client handed over", async () => {
		const { s, socketPath, host } = setup();
		s.up.value = true;
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", keepClient: true, deps: s.deps });
		expect(res.success && res.data.client !== undefined).toBe(true);
		expect(s.connects.total).toBe(1);
		expect(s.closes.count).toBe(0);
		expect(s.spawns).toEqual([]);
	});

	test("a spawner with no stdout signal (an older helper) is polled until its socket answers", async () => {
		const { s, socketPath, host } = setup();
		s.listenAfterMs.value = 350;
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(res.success).toBe(true);
		expect(s.sleeps.length).toBeGreaterThanOrEqual(3);
		expect(s.sleeps.every((ms) => ms === 100)).toBe(true);
	});

	test.each(["closed", "timeout"] as const)(
		"a signal that ends '%s' without 'up' falls back to polling",
		async (outcome) => {
			const { s, socketPath, host } = setup();
			s.listenAfterMs.value = 250;
			s.signal.make = signalOf(outcome, { count: 0 });
			const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
			expect(res.success).toBe(true);
			expect(s.sleeps.length).toBeGreaterThanOrEqual(2);
		}
	);

	test("a helper that dies before it signals: fails with the log tail, without waiting out the poll budget", async () => {
		const { s, socketPath, host } = setup();
		s.listenAfterMs.value = undefined;
		const spawn = s.deps.spawnDetached;
		const deps: HelperDeps = {
			...s.deps,
			spawnDetached: (spec) => {
				const out = spawn(spec);
				writeFileSync(spec.logPath, "dyld: Library not loaded\n");
				s.alive.delete(out.pid);
				return { ...out, signal: signalOf("closed", { count: 0 })() };
			},
		};
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.message).toContain("exited before it was ready: dyld: Library not loaded");
		expect(s.clock.t - 1_000_000).toBeLessThan(1000);
	});

	test("the stdout signal is released when ensureHelper returns, whether it worked or not", async () => {
		const worked = setup();
		const detached = { count: 0 };
		worked.s.signal.make = signalOf("up", detached);
		await ensureHelper(worked.host, UDID, { socketPath: worked.socketPath, helperPath: "/h/w", deps: worked.s.deps });
		expect(detached.count).toBe(1);
		ctx?.cleanup();

		const failed = setup();
		failed.s.listenAfterMs.value = undefined;
		failed.s.signal.make = signalOf("timeout", detached);
		const res = await ensureHelper(failed.host, UDID, {
			socketPath: failed.socketPath,
			helperPath: "/h/w",
			deps: failed.s.deps,
		});
		expect(res.success).toBe(false);
		expect(detached.count).toBe(2);
	});

	test("the record keeps the lease owner and the helper binary it was spawned from", async () => {
		const { s, c, socketPath, host } = setup();
		lease(c, agentA);
		s.mtimes.set("/h/w", 300);
		await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(readState(c, UDID).helper).toEqual({
			pid: 4242,
			socket: socketPath,
			owner: ownerKey(agentA),
			binary: { path: "/h/w", mtimeMs: 300 },
			env: simdEnvKey(c.env),
			lease: c.db.findLeaseByResource({ kind: "device", platform: "ios", id: UDID, name: UDID })?.id,
		});
	});

	test("$WARDEN_SIMD_IDLE_TIMEOUT sets the helper's idle exit; the option wins; a bad value is a usage error", async () => {
		const env = setup();
		env.c.env = { ...env.c.env, WARDEN_SIMD_IDLE_TIMEOUT: "90s" };
		await ensureHelper(env.host, UDID, { socketPath: env.socketPath, helperPath: "/h/w", deps: env.s.deps });
		expect(env.s.spawns[0]?.cmd.slice(-2)).toEqual(["--idle-timeout", "90"]);
		ctx?.cleanup();

		const option = setup();
		option.c.env = { ...option.c.env, WARDEN_SIMD_IDLE_TIMEOUT: "90s" };
		await ensureHelper(option.host, UDID, {
			socketPath: option.socketPath,
			helperPath: "/h/w",
			idleTimeout: "2m",
			deps: option.s.deps,
		});
		expect(option.s.spawns[0]?.cmd.slice(-2)).toEqual(["--idle-timeout", "120"]);
		ctx?.cleanup();

		const bad = setup();
		bad.c.env = { ...bad.c.env, WARDEN_SIMD_IDLE_TIMEOUT: "soon" };
		const res = await ensureHelper(bad.host, UDID, {
			socketPath: bad.socketPath,
			helperPath: "/h/w",
			deps: bad.s.deps,
		});
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.code).toBe("usage");
		expect(bad.s.spawns).toEqual([]);
	});
});

describe("ensureHelper: a resident helper", () => {
	function resident(owner?: Owner, record: Omit<HelperRecord, "pid" | "socket"> = {}) {
		const t = setup();
		if (owner) lease(t.c, owner);
		t.s.up.value = true;
		t.s.alive.add(777);
		mkdirSync(join(t.socketPath, ".."), { recursive: true });
		writeFileSync(t.socketPath, "");
		writeState(t.c, UDID, {
			generation: 0,
			updatedAt: 0,
			helper: { pid: 777, socket: t.socketPath, ...record },
		});
		return t;
	}

	test("the owner that started it uses it again: no stop, no spawn, one connect", async () => {
		const { s, socketPath, host } = resident(agentA, { owner: ownerKey(agentA) });
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: false } });
		expect(s.requests).toEqual([]);
		expect(s.spawns).toEqual([]);
		expect(s.connects.total).toBe(1);
	});

	test("the lease passed to another owner with the same env and binary: reused, not replaced (14-5)", async () => {
		const { s, socketPath, host } = resident(agentB, { owner: ownerKey(agentA) });
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: false } });
		expect(s.requests).toEqual([]);
		expect(s.spawns).toEqual([]);
	});

	test("owner churn user:1 → user:2 (a new shell pid per `bun run`): the second ensureHelper does not stop the first's helper", async () => {
		const { s, c, socketPath, host } = setup();
		s.mtimes.set("/h/w", 100);
		s.signal.make = signalOf("up", { count: 0 });
		const user = (pid: number): Owner => ({ kind: "user", pid, cwd: "/w" });
		const first = c.db.insertLease(
			{ resource: { kind: "device", platform: "ios", id: UDID, name: "sim" }, owner: user(1), ttlMs: 3_600_000 },
			c.now()
		);
		expect(await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps })).toMatchObject({
			success: true,
			data: { spawned: true },
		});
		c.db.deleteLeases([first.id]);
		lease(c, user(2));
		const second = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: s.deps });
		expect(second).toEqual({ success: true, data: { socketPath, spawned: false } });
		expect(s.requests).toEqual([]);
		expect(s.kills).toEqual([]);
		expect(s.spawns).toHaveLength(1);
	});

	test("the WARDEN_SIMD_* env changed since the helper was spawned: replaced; other env changes: reused", async () => {
		const changed = resident(agentA, { env: simdEnvKey({ WARDEN_SIMD_PACE_MS: "10" }) });
		changed.c.env = { ...changed.c.env, WARDEN_SIMD_PACE_MS: "20" };
		const res = await ensureHelper(changed.host, UDID, {
			socketPath: changed.socketPath,
			helperPath: "/h/w",
			deps: changed.s.deps,
		});
		expect(res.success && res.data.spawned).toBe(true);
		expect(changed.s.requests).toEqual(["shutdown"]);
		expect(readState(changed.c, UDID).helper?.env).toBe(simdEnvKey({ WARDEN_SIMD_PACE_MS: "20" }));
		ctx?.cleanup();

		const other = resident(agentA, { env: simdEnvKey({ WARDEN_SIMD_PACE_MS: "10" }) });
		other.c.env = {
			...other.c.env,
			WARDEN_SIMD_PACE_MS: "10",
			WARDEN_SIMD: "/elsewhere/warden-simd",
			WARDEN_SIMD_SOCKET: "/x.sock",
			PATH: "/changed",
		};
		const reused = await ensureHelper(other.host, UDID, {
			socketPath: other.socketPath,
			helperPath: "/h/w",
			deps: other.s.deps,
		});
		expect(reused.success && reused.data.spawned).toBe(false);
		expect(other.s.requests).toEqual([]);
	});

	test("the binary changed but the helper was spawned under the device's current lease: kept for the rest of the run", async () => {
		const t = setup();
		lease(t.c, agentA);
		const held = t.c.db.findLeaseByResource({ kind: "device", platform: "ios", id: UDID, name: UDID });
		t.s.up.value = true;
		t.s.alive.add(777);
		t.s.mtimes.set("/h/w", 200);
		writeState(t.c, UDID, {
			generation: 0,
			updatedAt: 0,
			helper: { pid: 777, socket: t.socketPath, binary: { path: "/h/w", mtimeMs: 100 }, lease: held?.id ?? "" },
		});
		const res = await ensureHelper(t.host, UDID, { socketPath: t.socketPath, helperPath: "/h/w", deps: t.s.deps });
		expect(res).toEqual({ success: true, data: { socketPath: t.socketPath, spawned: false } });
		expect(t.s.requests).toEqual([]);
	});

	test("the binary is compared by realpath: a symlinked path to the same helper is not a change", async () => {
		const t = resident(agentA, { binary: { path: "/real/warden-simd", mtimeMs: 100 } });
		t.s.mtimes.set("/real/warden-simd", 100);
		t.s.mtimes.set("/link/warden-simd", 100);
		const deps: HelperDeps = {
			...t.s.deps,
			realpath: (path) => (path === "/link/warden-simd" ? "/real/warden-simd" : path),
		};
		const res = await ensureHelper(t.host, UDID, { socketPath: t.socketPath, helperPath: "/link/warden-simd", deps });
		expect(res.success && res.data.spawned).toBe(false);
		expect(t.s.requests).toEqual([]);
	});

	test("a record with no owner (older warden) or a device with no lease is not guessed at: it is reused", async () => {
		const noOwner = resident(agentB, {});
		const first = await ensureHelper(noOwner.host, UDID, {
			socketPath: noOwner.socketPath,
			helperPath: "/h/w",
			deps: noOwner.s.deps,
		});
		expect(first).toEqual({ success: true, data: { socketPath: noOwner.socketPath, spawned: false } });
		expect(noOwner.s.spawns).toEqual([]);
		ctx?.cleanup();

		const noLease = resident(undefined, { owner: ownerKey(agentA) });
		const second = await ensureHelper(noLease.host, UDID, {
			socketPath: noLease.socketPath,
			helperPath: "/h/w",
			deps: noLease.s.deps,
		});
		expect(second).toEqual({ success: true, data: { socketPath: noLease.socketPath, spawned: false } });
		expect(noLease.s.spawns).toEqual([]);
	});

	test("the helper binary changed since it was spawned (rebuilt, upgraded): replaced; unchanged: reused", async () => {
		const changed = resident(agentA, { owner: ownerKey(agentA), binary: { path: "/h/w", mtimeMs: 100 } });
		changed.s.mtimes.set("/h/w", 200);
		const res = await ensureHelper(changed.host, UDID, {
			socketPath: changed.socketPath,
			helperPath: "/h/w",
			deps: changed.s.deps,
		});
		expect(res.success && res.data.spawned).toBe(true);
		expect(changed.s.requests).toEqual(["shutdown"]);
		expect(readState(changed.c, UDID).helper?.binary).toEqual({ path: "/h/w", mtimeMs: 200 });
		ctx?.cleanup();

		const same = resident(agentA, { owner: ownerKey(agentA), binary: { path: "/h/w", mtimeMs: 100 } });
		same.s.mtimes.set("/h/w", 100);
		const reused = await ensureHelper(same.host, UDID, {
			socketPath: same.socketPath,
			helperPath: "/h/w",
			deps: same.s.deps,
		});
		expect(reused.success && reused.data.spawned).toBe(false);
		expect(same.s.spawns).toEqual([]);
	});

	test("another caller already replacing it (live spawn row): waits for the new helper, never stops it twice", async () => {
		const { s, c, socketPath, host } = resident(agentB, { env: "stale-env" });
		c.db.setMeta(`simd_spawn:${UDID}`, JSON.stringify({ pid: 999, at: s.clock.t }));
		s.alive.add(999);
		let polls = 0;
		const connect = s.deps.connect;
		const deps: HelperDeps = {
			...s.deps,
			connect: async (path) => {
				polls += 1;
				if (polls === 3)
					writeState(c, UDID, {
						generation: 0,
						updatedAt: 0,
						helper: { pid: 888, socket: socketPath, env: simdEnvKey(c.env) },
					});
				return connect(path);
			},
		};
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: false } });
		expect(s.requests).toEqual([]);
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

describe("pid identity before a signal (14-4)", () => {
	const foreign = () => "/usr/bin/vim notes.txt";

	/** A recorded helper `pid` with its socket file; `command` reads command lines (`up`: it answers but ignores shutdown). */
	function recorded(
		command: (pid: number, socketPath: string) => string | undefined,
		opts: { pid?: number; up?: boolean } = {}
	) {
		const t = setup();
		const pid = opts.pid ?? 4242;
		mkdirSync(join(t.socketPath, ".."), { recursive: true });
		writeFileSync(t.socketPath, "");
		t.s.alive.add(pid);
		t.s.up.value = opts.up === true;
		writeState(t.c, UDID, { generation: 0, updatedAt: 0, helper: { pid, socket: t.socketPath } });
		const deps: HelperDeps = { ...t.s.deps, command: (p) => command(p, t.socketPath) };
		return { ...t, deps };
	}

	test("the recorded pid now runs another program: no signal, no wait, the record and stale socket are dropped", async () => {
		const { c, s, socketPath, deps } = recorded(foreign);
		expect((await stopHelper(c, UDID, { deps })).stopped).toBe(true);
		expect(s.kills).toEqual([]);
		expect(s.clock.t - 1_000_000).toBeLessThan(100);
		expect(existsSync(socketPath)).toBe(false);
		expect(readState(c, UDID).helper).toBeUndefined();
	});

	test("the recorded pid is still `warden-simd --udid <udid> --socket <socket>`: SIGTERMed as before", async () => {
		const { c, s, deps } = recorded(
			(pid, socketPath) =>
				pid === 4242 ? `/opt/warden/warden-simd --udid ${UDID} --socket ${socketPath} --idle-timeout 600` : undefined,
			{ up: true }
		);
		expect(await stopHelper(c, UDID, { deps })).toEqual({ stopped: true, how: "sigterm" });
		expect(s.kills).toEqual([[4242, "SIGTERM"]]);
	});

	test("a command line that cannot be read is not signalled, and the helper is kept: record, socket, a warning", async () => {
		const { c, s, socketPath, deps } = recorded(() => undefined, { up: true });
		const out = await stopHelper(c, UDID, { deps });
		expect(out.stopped).toBe(false);
		expect(out.warning).toContain("could not stop warden-simd (pid 4242)");
		expect(s.kills).toEqual([]);
		expect(existsSync(socketPath)).toBe(true);
		expect(readState(c, UDID).helper).toEqual({ pid: 4242, socket: socketPath });
	});

	test("no socket file, the recorded pid alive and unreadable: kept with a warning, and ensureHelper spawns no second one (S1)", async () => {
		const { s, socketPath, host, c } = setup();
		s.alive.add(777);
		writeState(c, UDID, { generation: 0, updatedAt: 0, helper: { pid: 777, socket: socketPath } });
		const deps: HelperDeps = { ...s.deps, command: () => undefined };
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.message).toContain("not starting a second one");
		expect(s.spawns).toEqual([]);
		expect(s.kills).toEqual([]);
		expect(readState(c, UDID).helper).toEqual({ pid: 777, socket: socketPath });
		const out = await stopHelper(c, UDID, { deps });
		expect(out).toMatchObject({ stopped: false, how: "none" });
		expect(out.warning).toContain("could not stop warden-simd (pid 777)");
		expect(readState(c, UDID).helper).toEqual({ pid: 777, socket: socketPath });
	});

	test("ensureHelper giving up on its own child signals it on liveness alone, even when its command line cannot be read", async () => {
		const { s, socketPath, host, c } = setup();
		s.listenAfterMs.value = undefined;
		const deps: HelperDeps = { ...s.deps, command: () => undefined };
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res.success).toBe(false);
		expect(s.kills).toEqual([[4242, "SIGTERM"]]);
		expect(readState(c, UDID).helper).toBeUndefined();
	});

	test("ensureHelper: a refusing socket whose recorded pid was reused spawns at once, signalling nobody", async () => {
		const { c, s, socketPath, host, deps } = recorded(foreign, { pid: 777 });
		const res = await ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4242 } });
		expect(s.kills).toEqual([]);
		expect(s.spawns).toHaveLength(1);
		expect(s.clock.t - 1_000_000).toBeLessThan(SHUTDOWN_WAIT_MS);
		expect(readState(c, UDID).helper?.pid).toBe(4242);
	});

	test("status: a recorded pid that now runs another program is not running", () => {
		const { c, deps } = recorded(foreign);
		expect(helperStatus(c, UDID, deps).running).toBe(false);
	});
});

describe("stopHelper racing a spawn (14-3)", () => {
	/** A recorded helper (pid 4242) whose socket file exists and that ignores shutdown, so the stop waits ≤ 2 s. */
	function resident() {
		const t = setup();
		mkdirSync(join(t.socketPath, ".."), { recursive: true });
		writeFileSync(t.socketPath, "old");
		t.s.alive.add(4242);
		t.s.up.value = true;
		writeState(t.c, UDID, { generation: 0, updatedAt: 0, helper: { pid: 4242, socket: t.socketPath } });
		return t;
	}

	test("a new helper that takes the socket path and the record during the stop's wait keeps both", async () => {
		const { c, s, socketPath } = resident();
		let replaced = false;
		const deps: HelperDeps = {
			...s.deps,
			sleep: async (ms) => {
				await s.deps.sleep(ms);
				if (replaced) return;
				replaced = true;
				// the old helper exits (removing its socket); a new one binds the same path and records itself
				s.alive.delete(4242);
				unlinkSync(socketPath);
				writeFileSync(socketPath, "new");
				s.alive.add(5555);
				writeState(c, UDID, { ...readState(c, UDID), helper: { pid: 5555, socket: socketPath } });
			},
		};
		expect((await stopHelper(c, UDID, { deps })).stopped).toBe(true);
		expect(readFileSync(socketPath, "utf8")).toBe("new");
		expect(readState(c, UDID).helper).toEqual({ pid: 5555, socket: socketPath });
		expect(s.kills).toEqual([]);
	});

	test("stopHelper holds the spawn row: an ensureHelper racing it waits, and the helper it spawns afterwards survives", async () => {
		const { c, s, socketPath, host } = resident();
		const stopDeps: HelperDeps = { ...s.deps, pid: 111 };
		const spawnerDeps: HelperDeps = {
			...s.deps,
			pid: 222,
			// the old helper refuses new clients while it shuts down; once it is SIGTERMed, the spawned one answers
			connect: async (path) => (s.kills.length === 0 ? { success: false, error: refused } : s.deps.connect(path)),
			spawnDetached: (spec) => {
				const out = s.deps.spawnDetached(spec);
				writeFileSync(socketPath, "new");
				return out;
			},
		};
		s.alive.add(222);
		const stopping = stopHelper(c, UDID, { deps: stopDeps });
		const ensuring = ensureHelper(host, UDID, { socketPath, helperPath: "/h/w", deps: spawnerDeps });
		const [stopped, ensured] = await Promise.all([stopping, ensuring]);
		expect(stopped).toEqual({ stopped: true, how: "sigterm" });
		expect(ensured).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4242 } });
		expect(readFileSync(socketPath, "utf8")).toBe("new");
		expect(readState(c, UDID).helper?.pid).toBe(4242);
		expect(c.db.getMeta(`simd_spawn:${UDID}`)).toBeUndefined();
	});

	test("a spawn row held by a live spawner: stopHelper waits briefly, then stops anyway without taking the row", async () => {
		const { c, s } = resident();
		s.alive.add(999);
		c.db.setMeta(`simd_spawn:${UDID}`, JSON.stringify({ pid: 999, at: s.clock.t }));
		expect((await stopHelper(c, UDID, { deps: s.deps })).stopped).toBe(true);
		expect(s.kills).toEqual([[4242, "SIGTERM"]]);
		expect(c.db.getMeta(`simd_spawn:${UDID}`)).toContain("999");
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

describe("watchStart (the child's stdout)", () => {
	const encoder = new TextEncoder();
	const READY = JSON.stringify({ event: "ready", socket: "/s.sock", pid: 9, udid: UDID, protocol: 1 });

	function stream(chunks: string[], opts: { end: boolean; cancelled?: { count: number } }): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				if (opts.end) controller.close();
			},
			cancel() {
				if (opts.cancelled) opts.cancelled.count += 1;
			},
		});
	}

	function logFile(): string {
		const c = testContext([]);
		ctx = c;
		return join(c.cwd, "child.log");
	}

	test("the ready line, even split across chunks, means the socket is up; every line lands in the log", async () => {
		const logPath = logFile();
		const half = Math.floor(READY.length / 2);
		const signal = watchStart(
			stream(['{"event":"log","level":"info","message":"hid ok"}\n', READY.slice(0, half), `${READY.slice(half)}\n`], {
				end: false,
			}),
			{ logPath, timeoutMs: 5000 }
		);
		expect(await signal.up).toBe("up");
		signal.detach();
		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("hid ok");
		expect(log).toContain(READY);
	});

	test("an older helper's `listening on` log line counts too", async () => {
		const logPath = logFile();
		const line = JSON.stringify({ event: "log", level: "info", message: "listening on /s.sock (idle timeout 600s)" });
		const signal = watchStart(stream([`${line}\n`], { end: false }), { logPath, timeoutMs: 5000 });
		expect(await signal.up).toBe("up");
		signal.detach();
	});

	test("a per-connection ready (no socket) and other events are not the signal", async () => {
		const logPath = logFile();
		const handshake = JSON.stringify({ event: "ready", protocol: 1, udid: UDID });
		const fatal = JSON.stringify({ event: "fatal", error: { code: "E_NOT_BOOTED", message: "Shutdown" } });
		const signal = watchStart(stream([`${handshake}\n`, `${fatal}\n`], { end: true }), { logPath, timeoutMs: 5000 });
		expect(await signal.up).toBe("closed");
		expect(readFileSync(logPath, "utf8")).toContain("E_NOT_BOOTED");
	});

	test("stdout ending with nothing at all is 'closed'; a silent stdout is 'timeout'", async () => {
		const logPath = logFile();
		expect(await watchStart(stream([], { end: true }), { logPath, timeoutMs: 5000 }).up).toBe("closed");
		const silent = watchStart(stream([], { end: false }), { logPath, timeoutMs: 20 });
		expect(await silent.up).toBe("timeout");
		silent.detach();
	});

	test("detach stops reading the pipe", async () => {
		const logPath = logFile();
		const cancelled = { count: 0 };
		const signal = watchStart(stream([`${READY}\n`], { end: false, cancelled }), { logPath, timeoutMs: 5000 });
		await signal.up;
		signal.detach();
		await Bun.sleep(5);
		expect(cancelled.count).toBe(1);
	});
});
