import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DriverError } from "@delacour/warden-e2e/driver/driver.types";
import type { SimdClient } from "@delacour/warden-e2e/driver/ios/simd-client";
import type { Result } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import {
	ensureIosRunner,
	type HelperDeps,
	helperStatus,
	IOS_RUNNER_KIND,
	IOS_RUNNER_STARTUP_MS,
	iosRunnerEnvKey,
	type SpawnSpec,
	socketPathOf,
	stopIosRunner,
	sweepDeadHelpers,
} from "./helper";
import { findDeadHelpers, knownUdids, stopIosRunnersLazily } from "./helper-sweep";
import { readState } from "./state";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const UDID = "00008140-000A0B0C0D0E0F10";
const SELF = ["/usr/local/bin/warden"];
const refused: DriverError = { code: "E_HELPER_CRASHED", message: "ECONNREFUSED", retryable: true };

/** `upAfterMs`: the fake clock time (since the spawn) at which the runner starts accepting, i.e. how long xcodebuild takes. */
function setup(upAfterMs = 0) {
	const clock = { t: 1_000_000 };
	const state = { spawnedAt: undefined as number | undefined };
	const alive = new Set<number>([111]);
	const spawns: SpawnSpec[] = [];
	const requests: string[] = [];
	const kills: number[] = [];
	const isUp = () => state.spawnedAt !== undefined && clock.t - state.spawnedAt >= upAfterMs && alive.has(4343);
	const client = {
		request: async (op: string) => {
			requests.push(op);
			if (op === "shutdown") alive.delete(4343);
			return { success: true, data: null };
		},
		close: async () => undefined,
	} as unknown as SimdClient;
	const deps: HelperDeps<SimdClient> = {
		connect: async (): Promise<Result<SimdClient, DriverError>> =>
			isUp() ? { success: true, data: client } : { success: false, error: refused },
		spawnDetached: (spec) => {
			spawns.push(spec);
			const socket = spec.cmd[spec.cmd.indexOf("--socket") + 1];
			if (socket !== undefined) {
				mkdirSync(dirname(socket), { recursive: true });
				writeFileSync(socket, "");
			}
			alive.add(4343);
			state.spawnedAt = clock.t;
			return { pid: 4343 };
		},
		pidAlive: (pid) => alive.has(pid),
		kill: (pid) => {
			kills.push(pid);
			alive.delete(pid);
		},
		sleep: async (ms) => {
			clock.t += ms;
		},
		now: () => clock.t,
		pid: 111,
		mtime: (path) => (path === SELF[0] ? 42 : undefined),
		self: () => SELF,
	};
	const c = testContext([], { now: () => clock.t });
	ctx = c;
	return { c, deps, spawns, requests, kills, alive };
}

describe("ios runner kind", () => {
	test("lives under $WARDEN_HOME/ios-runner, keyed by udid", () => {
		expect(socketPathOf(IOS_RUNNER_KIND, { env: { WARDEN_HOME: "/h" } }, UDID)).toBe(`/h/ios-runner/${UDID}.sock`);
	});

	test("its env key follows WARDEN_IOS_* knobs but not the client-only runner socket", () => {
		const base = iosRunnerEnvKey({ WARDEN_IOS_RUNNER_IDLE_TIMEOUT: "5m" });
		expect(iosRunnerEnvKey({ WARDEN_IOS_RUNNER_IDLE_TIMEOUT: "5m", WARDEN_IOS_RUNNER_SOCKET: "/x.sock" })).toBe(base);
		expect(iosRunnerEnvKey({ WARDEN_IOS_RUNNER_IDLE_TIMEOUT: "9m" })).not.toBe(base);
		expect(iosRunnerEnvKey({ WARDEN_IOS_RUNNER_IDLE_TIMEOUT: "5m", WARDEN_SIMD_PACE_MS: "9" })).toBe(base);
	});
});

describe("ensureIosRunner", () => {
	test("spawns warden itself as __ios-runner-host and records it as iosRunner", async () => {
		const { c, deps, spawns } = setup();
		const socketPath = socketPathOf(IOS_RUNNER_KIND, c, UDID);
		const res = await ensureIosRunner(c, UDID, { deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4343 } });
		expect(spawns[0]?.cmd).toEqual([
			...SELF,
			"__ios-runner-host",
			"--udid",
			UDID,
			"--socket",
			socketPath,
			"--idle-timeout",
			"600",
		]);
		expect(spawns[0]?.logPath).toBe(join(c.cwd, "ios-runner", `${UDID}.log`));
		expect(spawns[0]?.signalMs).toBe(IOS_RUNNER_STARTUP_MS);
		const state = readState(c, UDID);
		expect(state.iosRunner).toEqual({
			pid: 4343,
			socket: socketPath,
			binary: { path: SELF[0] ?? "", mtimeMs: 42 },
			env: iosRunnerEnvKey(c.env),
		});
		expect(state.helper).toBeUndefined();
		expect(c.db.getMeta(`ios_runner_spawn:${UDID}`)).toBeUndefined();
	});

	test("$WARDEN_IOS_RUNNER_IDLE_TIMEOUT sets the host's idle timeout (default 10 min)", async () => {
		const { c, deps, spawns } = setup();
		c.env.WARDEN_IOS_RUNNER_IDLE_TIMEOUT = "2m";
		await ensureIosRunner(c, UDID, { deps });
		expect(spawns[0]?.cmd.slice(-2)).toEqual(["--idle-timeout", "120"]);
	});

	test("a runner that takes 40 s to come up is waited for, not abandoned at the 15 s simd limit", async () => {
		const { c, deps, spawns, kills } = setup(40_000);
		const res = await ensureIosRunner(c, UDID, { deps });
		expect(res.success).toBe(true);
		expect(spawns).toHaveLength(1);
		expect(kills).toEqual([]);
	});

	test("a runner that never comes up is abandoned after the startup window, with its child stopped", async () => {
		const { c, deps, kills } = setup(10 * IOS_RUNNER_STARTUP_MS);
		const res = await ensureIosRunner(c, UDID, { deps });
		expect(res.success).toBe(false);
		expect(kills).toEqual([4343]);
		expect(readState(c, UDID).iosRunner).toBeUndefined();
	});

	test("a host that died before ready (locked phone) reports the log's last lines", async () => {
		const { c, deps, alive } = setup(10 * IOS_RUNNER_STARTUP_MS);
		const slow = deps.spawnDetached;
		deps.spawnDetached = (spec) => {
			const spawned = slow(spec);
			writeFileSync(spec.logPath, "warden __ios-runner-host: E_DEVICE_LOCKED: Unlock the phone to Continue\n");
			alive.delete(4343);
			return spawned;
		};
		const res = await ensureIosRunner(c, UDID, { deps });
		if (res.success) throw new Error("expected failure");
		expect(res.error.message).toContain("E_DEVICE_LOCKED");
	});

	test("a runner already answering is reused, and a changed warden binary replaces it", async () => {
		const { c, deps, spawns } = setup();
		await ensureIosRunner(c, UDID, { deps });
		await ensureIosRunner(c, UDID, { deps });
		expect(spawns).toHaveLength(1);
		await ensureIosRunner(c, UDID, { deps: { ...deps, mtime: () => 43 } });
		expect(spawns).toHaveLength(2);
	});
});

describe("stopping and sweeping the ios runner", () => {
	test("stopIosRunner asks for shutdown and forgets the record", async () => {
		const { c, deps, requests } = setup();
		await ensureIosRunner(c, UDID, { deps });
		const stop = await stopIosRunner(c, UDID, { deps });
		expect(stop.stopped).toBe(true);
		expect(requests).toContain("shutdown");
		expect(readState(c, UDID).iosRunner).toBeUndefined();
	});

	test("helperStatus reads the iosRunner record when asked for that kind", async () => {
		const { c, deps } = setup();
		await ensureIosRunner(c, UDID, { deps });
		expect(helperStatus(c, UDID, { pidAlive: deps.pidAlive }, IOS_RUNNER_KIND).pid).toBe(4343);
		expect(helperStatus(c, UDID, { pidAlive: deps.pidAlive }).pid).toBeNull();
	});

	test("gc finds and drops a dead runner host's record, and knows the udid from its socket", async () => {
		const { c, deps, alive } = setup();
		await ensureIosRunner(c, UDID, { deps });
		expect(knownUdids(c)).toContain(UDID);
		alive.delete(4343);
		expect(findDeadHelpers(c, deps.pidAlive)).toEqual([UDID]);
		sweepDeadHelpers(c, { pidAlive: deps.pidAlive });
		expect(readState(c, UDID).iosRunner).toBeUndefined();
	});

	test("stopIosRunnersLazily loads the helper only for udids with a recorded runner", async () => {
		const { c, deps } = setup();
		let loads = 0;
		const stopped: string[] = [];
		const load = async () => {
			loads += 1;
			return {
				stopIosRunner: async (_host: unknown, udid: string) => {
					stopped.push(udid);
					return { stopped: true, how: "shutdown" as const };
				},
			};
		};
		expect(await stopIosRunnersLazily(c, [UDID], { load })).toEqual([]);
		expect(loads).toBe(0);
		await ensureIosRunner(c, UDID, { deps });
		await stopIosRunnersLazily(c, [UDID, "00008140-0000000000000000"], { load });
		expect(loads).toBe(1);
		expect(stopped).toEqual([UDID]);
	});
});
