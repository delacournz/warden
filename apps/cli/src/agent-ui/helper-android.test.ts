import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DriverError } from "@delacour/warden-e2e/driver/driver.types";
import type { RemoteClient } from "@delacour/warden-e2e/driver/remote/remote-client";
import type { Result } from "@delacour/warden-types/result";
import { type TestContext, testContext } from "../testing";
import {
	ANDROID_HOST_KIND,
	androidHostEnvKey,
	ensureAndroidHost,
	type HelperDeps,
	helperStatus,
	type SpawnSpec,
	socketPathOf,
	stopAndroidHost,
	sweepDeadHelpers,
} from "./helper";
import { stopAndroidHostsLazily } from "./helper-sweep";
import { readState } from "./state";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const SERIAL = "emulator-5554";
const SELF = ["/usr/local/bin/warden"];
const refused: DriverError = { code: "E_HELPER_CRASHED", message: "ECONNREFUSED", retryable: true };

function setup() {
	const clock = { t: 1_000_000 };
	const up = { value: false };
	const alive = new Set<number>([111]);
	const spawns: SpawnSpec[] = [];
	const requests: string[] = [];
	const kills: number[] = [];
	const client = {
		request: async (op: string) => {
			requests.push(op);
			if (op === "shutdown") {
				up.value = false;
				alive.delete(4343);
			}
			return { success: true, data: null };
		},
		close: async () => undefined,
		driver: () => {
			throw new Error("not used");
		},
		ready: {},
	} as unknown as RemoteClient;
	const deps: HelperDeps<RemoteClient> = {
		connect: async (): Promise<Result<RemoteClient, DriverError>> =>
			up.value ? { success: true, data: client } : { success: false, error: refused },
		spawnDetached: (spec) => {
			spawns.push(spec);
			const socket = spec.cmd[spec.cmd.indexOf("--socket") + 1];
			if (socket !== undefined) {
				mkdirSync(dirname(socket), { recursive: true });
				writeFileSync(socket, "");
			}
			alive.add(4343);
			up.value = true;
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
	return { c, deps, spawns, requests, kills, alive, up };
}

describe("android host kind", () => {
	test("lives under $WARDEN_HOME/android-host, keyed by serial", () => {
		expect(socketPathOf(ANDROID_HOST_KIND, { env: { WARDEN_HOME: "/h" } }, SERIAL)).toBe(
			`/h/android-host/${SERIAL}.sock`
		);
	});

	test("its env key follows WARDEN_ANDROID_* knobs but not the client-only WARDEN_ANDROID_HOST switch", () => {
		const base = androidHostEnvKey({ WARDEN_ANDROID_UIAD: "1" });
		expect(androidHostEnvKey({ WARDEN_ANDROID_UIAD: "1", WARDEN_ANDROID_HOST: "1" })).toBe(base);
		expect(androidHostEnvKey({ WARDEN_ANDROID_UIAD: "0" })).not.toBe(base);
		expect(androidHostEnvKey({ WARDEN_ANDROID_UIAD: "1", WARDEN_SIMD_PACE_MS: "9" })).toBe(base);
	});
});

describe("ensureAndroidHost", () => {
	test("spawns warden itself as the hidden host subcommand and records it as androidHost", async () => {
		const { c, deps, spawns } = setup();
		const socketPath = socketPathOf(ANDROID_HOST_KIND, c, SERIAL);
		const res = await ensureAndroidHost(c, SERIAL, { deps });
		expect(res).toEqual({ success: true, data: { socketPath, spawned: true, pid: 4343 } });
		expect(spawns[0]?.cmd).toEqual([
			...SELF,
			"__android-host",
			"--serial",
			SERIAL,
			"--socket",
			socketPath,
			"--idle-timeout",
			"600",
		]);
		expect(spawns[0]?.logPath).toBe(join(c.cwd, "android-host", `${SERIAL}.log`));
		const state = readState(c, SERIAL);
		expect(state.androidHost).toEqual({
			pid: 4343,
			socket: socketPath,
			binary: { path: SELF[0] ?? "", mtimeMs: 42 },
			env: androidHostEnvKey(c.env),
		});
		expect(state.helper).toBeUndefined();
		expect(c.db.getMeta(`android_host_spawn:${SERIAL}`)).toBeUndefined();
	});

	test("$WARDEN_ANDROID_HOST_IDLE_TIMEOUT sets the host's idle timeout", async () => {
		const { c, deps, spawns } = setup();
		c.env.WARDEN_ANDROID_HOST_IDLE_TIMEOUT = "2m";
		await ensureAndroidHost(c, SERIAL, { deps });
		expect(spawns[0]?.cmd.slice(-2)).toEqual(["--idle-timeout", "120"]);
	});

	test("a host already answering is reused, and a changed warden binary replaces it", async () => {
		const { c, deps, spawns } = setup();
		await ensureAndroidHost(c, SERIAL, { deps });
		await ensureAndroidHost(c, SERIAL, { deps });
		expect(spawns).toHaveLength(1);
		const rebuilt: HelperDeps<RemoteClient> = { ...deps, mtime: () => 43 };
		await ensureAndroidHost(c, SERIAL, { deps: rebuilt });
		expect(spawns).toHaveLength(2);
	});
});

describe("stopping and sweeping android hosts", () => {
	test("stopAndroidHost asks for shutdown and forgets the record", async () => {
		const { c, deps, requests } = setup();
		await ensureAndroidHost(c, SERIAL, { deps });
		const stop = await stopAndroidHost(c, SERIAL, { deps });
		expect(stop.stopped).toBe(true);
		expect(requests).toContain("shutdown");
		expect(readState(c, SERIAL).androidHost).toBeUndefined();
	});

	test("helperStatus reads the android record when asked for the android kind", async () => {
		const { c, deps } = setup();
		await ensureAndroidHost(c, SERIAL, { deps });
		const status = helperStatus(c, SERIAL, { pidAlive: deps.pidAlive }, ANDROID_HOST_KIND);
		expect(status.pid).toBe(4343);
		expect(helperStatus(c, SERIAL, { pidAlive: deps.pidAlive }).pid).toBeNull();
	});

	test("gc's sweep drops a dead host's record", async () => {
		const { c, deps, alive } = setup();
		await ensureAndroidHost(c, SERIAL, { deps });
		alive.delete(4343);
		sweepDeadHelpers(c, { pidAlive: deps.pidAlive });
		expect(readState(c, SERIAL).androidHost).toBeUndefined();
	});

	test("stopAndroidHostsLazily loads the helper only for serials with a recorded host", async () => {
		const { c, deps } = setup();
		let loads = 0;
		const stopped: string[] = [];
		const load = async () => {
			loads += 1;
			return {
				stopAndroidHost: async (_host: unknown, serial: string) => {
					stopped.push(serial);
					return { stopped: true, how: "shutdown" as const };
				},
			};
		};
		expect(await stopAndroidHostsLazily(c, [SERIAL], { load })).toEqual([]);
		expect(loads).toBe(0);
		await ensureAndroidHost(c, SERIAL, { deps });
		await stopAndroidHostsLazily(c, [SERIAL, "emulator-5556"], { load });
		expect(loads).toBe(1);
		expect(stopped).toEqual([SERIAL]);
	});
});
