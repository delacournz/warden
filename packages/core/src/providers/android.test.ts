import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@warden/types/result";
import { DEFAULT_TTL_MS } from "../config.defaults";
import type { Exec, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import {
	androidTools,
	createAndroidProvider,
	listAvds,
	parseAdbDevices,
	parseAvdList,
	pickConsolePort,
	type SpawnDetached,
} from "./android";
import { ADB_DEVICES_EMPTY, ADB_DEVICES_MIXED, EMU_AVD_NAME_PIXEL_10, EMULATOR_LIST_AVDS } from "./android.fixtures";
import type { ProviderDeps } from "./provider.types";

const SDK = "/sdk";
const ADB = `${SDK}/platform-tools/adb`;
const EMULATOR = `${SDK}/emulator/emulator`;
const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };

type Handler = ExecResult | ((cmd: readonly string[]) => ExecResult);

const out = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: "", stderr });

/** Fake exec: exact joined command → result. Unknown commands fail loudly. Records every call. */
function fakeExec(handlers: Record<string, Handler>): { exec: Exec; calls: string[] } {
	const calls: string[] = [];
	const exec: Exec = async (cmd) => {
		const key = cmd.join(" ");
		calls.push(key);
		const handler = handlers[key];
		if (handler === undefined) return fail(`unexpected command: ${key}`);
		return typeof handler === "function" ? handler(cmd) : handler;
	};
	return { exec, calls };
}

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-android-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function deps(exec: Exec, now: () => number = () => 1_000): ProviderDeps {
	return { exec, store, env: { ANDROID_HOME: SDK, WARDEN_HOME: dir }, now, owner };
}

describe("androidTools", () => {
	test("uses ANDROID_HOME, then ANDROID_SDK_ROOT, then PATH names", () => {
		expect(androidTools({ ANDROID_HOME: "/a" })).toEqual({
			adb: "/a/platform-tools/adb",
			emulator: "/a/emulator/emulator",
		});
		expect(androidTools({ ANDROID_SDK_ROOT: "/b" }).adb).toBe("/b/platform-tools/adb");
		expect(androidTools({})).toEqual({ adb: "adb", emulator: "emulator" });
	});
});

describe("parseAdbDevices", () => {
	test("keeps emulators only, maps states", () => {
		expect(parseAdbDevices(ADB_DEVICES_MIXED)).toEqual([
			{ serial: "emulator-5554", port: 5554, state: "device" },
			{ serial: "emulator-5556", port: 5556, state: "offline" },
		]);
	});

	test("empty list", () => {
		expect(parseAdbDevices(ADB_DEVICES_EMPTY)).toEqual([]);
	});
});

describe("parseAvdList / listAvds", () => {
	test("skips emulator log noise", () => {
		expect(parseAvdList(EMULATOR_LIST_AVDS)).toEqual(["Pixel_10", "Pixel_9_Pro_Store"]);
	});

	test("listAvds runs emulator -list-avds", async () => {
		const { exec } = fakeExec({ [`${EMULATOR} -list-avds`]: out(EMULATOR_LIST_AVDS) });
		expect(await listAvds(deps(exec))).toEqual(ok(["Pixel_10", "Pixel_9_Pro_Store"]));
	});

	test("listAvds surfaces failures", async () => {
		const { exec } = fakeExec({});
		const result = await listAvds(deps(exec));
		expect(result.success).toBe(false);
	});
});

describe("pickConsolePort", () => {
	test("first even port whose adb port is also free", () => {
		expect(pickConsolePort(new Set())).toBe(5554);
		expect(pickConsolePort(new Set([5554]))).toBe(5556);
		expect(pickConsolePort(new Set([5555]))).toBe(5556);
		expect(pickConsolePort(new Set([5554, 5556, 5559]))).toBe(5560);
	});

	test("undefined when the range is exhausted", () => {
		const all = new Set<number>();
		for (let p = 5554; p <= 5584; p += 2) all.add(p);
		expect(pickConsolePort(all)).toBeUndefined();
	});
});

describe("inventory", () => {
	test("emulators with AVD name, profile, runtime; physical devices ignored", async () => {
		const { exec, calls } = fakeExec({
			[`${ADB} devices -l`]: out(ADB_DEVICES_MIXED),
			[`${ADB} -s emulator-5554 emu avd name`]: out(EMU_AVD_NAME_PIXEL_10),
			[`${ADB} -s emulator-5554 shell getprop ro.build.version.sdk`]: out("35\n"),
			[`${ADB} -s emulator-5556 emu avd name`]: out("Pixel_9_Pro_Store\nOK\n"),
		});
		const result = await createAndroidProvider(deps(exec)).inventory();
		expect(result).toEqual(
			ok([
				{
					platform: "android",
					id: "emulator-5554",
					name: "Pixel_10",
					state: "booted",
					wardenCreated: false,
					profile: "pixel-10",
					runtime: "android-35",
				},
				{
					platform: "android",
					id: "emulator-5556",
					name: "Pixel_9_Pro_Store",
					state: "booting",
					wardenCreated: false,
					profile: "pixel-9-pro-store",
				},
			])
		);
		expect(calls.some((c) => c.includes("R5CT1234ABC"))).toBe(false);
	});

	test("warden-launched emulators use the recorded warden name", async () => {
		store.recordDevice({ platform: "android", id: "emulator-5554", name: "warden-pixel-10-1", profile: "pixel-10" }, 1);
		const { exec } = fakeExec({
			[`${ADB} devices -l`]: out(ADB_DEVICES_MIXED),
			[`${ADB} -s emulator-5554 emu avd name`]: out(EMU_AVD_NAME_PIXEL_10),
			[`${ADB} -s emulator-5554 shell getprop ro.build.version.sdk`]: out("35\n"),
			[`${ADB} -s emulator-5556 emu avd name`]: fail("error: device offline"),
		});
		const result = await createAndroidProvider(deps(exec)).inventory();
		if (!result.success) throw new Error(result.error);
		expect(result.data.map((d) => d.name)).toEqual(["warden-pixel-10-1", "emulator-5556"]);
		expect(result.data[0]?.wardenCreated).toBe(false);
	});

	test("adb failure → err", async () => {
		const { exec } = fakeExec({ [`${ADB} devices -l`]: fail("adb: not found") });
		const result = await createAndroidProvider(deps(exec)).inventory();
		expect(result.success).toBe(false);
	});
});

describe("create", () => {
	type Spawned = { cmd: readonly string[]; logPath: string };

	function spawnRecorder(result: "ok" | "fail" = "ok"): { spawn: SpawnDetached; spawned: Spawned[] } {
		const spawned: Spawned[] = [];
		const spawn: SpawnDetached = async (cmd, logPath) => {
			spawned.push({ cmd, logPath });
			return result === "ok" ? ok({ pid: 4242 }) : err("emulator exited 1");
		};
		return { spawn, spawned };
	}

	const baseHandlers = (devices: string): Record<string, Handler> => ({
		[`${EMULATOR} -list-avds`]: out(EMULATOR_LIST_AVDS),
		[`${ADB} devices -l`]: out(devices),
	});

	test("launches the AVD headless on a free port, records device + port lease", async () => {
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const { spawn, spawned } = spawnRecorder();
		const provider = createAndroidProvider(deps(exec), { spawnDetached: spawn });
		const result = await provider.create("warden-pixel-10-1", "pixel-10");
		expect(result).toEqual(
			ok({
				platform: "android",
				id: "emulator-5554",
				name: "warden-pixel-10-1",
				state: "booting",
				wardenCreated: true,
				profile: "pixel-10",
			})
		);
		expect(spawned[0]?.cmd).toEqual([
			EMULATOR,
			"-avd",
			"Pixel_10",
			"-port",
			"5554",
			"-no-window",
			"-read-only",
			"-no-snapshot-save",
			"-no-boot-anim",
		]);
		expect(spawned[0]?.logPath).toBe(join(dir, "logs", "emulator-5554.log"));
		const lease = store.findLeaseByResource({ kind: "port", port: 5554 });
		expect(lease?.owner).toEqual(owner);
		expect(lease?.ttlMs).toBe(DEFAULT_TTL_MS);
		expect(lease?.label).toBe("emulator warden-pixel-10-1");
		expect(store.listDevices("android")).toEqual([
			{
				platform: "android",
				id: "emulator-5554",
				name: "warden-pixel-10-1",
				profile: "pixel-10",
				createdAt: 1_000,
				lastUsedAt: 1_000,
			},
		]);
	});

	test("records runtime when given", async () => {
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const { spawn } = spawnRecorder();
		await createAndroidProvider(deps(exec), { spawnDetached: spawn }).create("w", "pixel-10", "android-35");
		expect(store.listDevices("android")[0]?.runtime).toBe("android-35");
	});

	test("skips leased ports, running emulators and ports whose adb port is taken", async () => {
		store.insertLease({ resource: { kind: "port", port: 5558 }, owner, ttlMs: 1 }, 1);
		store.insertLease({ resource: { kind: "port", port: 5561 }, owner, ttlMs: 1 }, 1);
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_MIXED));
		const { spawn, spawned } = spawnRecorder();
		const result = await createAndroidProvider(deps(exec), { spawnDetached: spawn }).create("w", "pixel-10");
		// 5554/5556 running, 5558 leased, 5560 blocked by leased adb port 5561
		expect(result.success && result.data.id).toBe("emulator-5562");
		expect(spawned[0]?.cmd).toContain("5562");
	});

	test("unknown profile → err listing AVDs, nothing leased", async () => {
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const { spawn, spawned } = spawnRecorder();
		const result = await createAndroidProvider(deps(exec), { spawnDetached: spawn }).create("w", "pixel");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("pixel-10");
			expect(result.error).toContain("pixel-9-pro-store");
		}
		expect(spawned).toHaveLength(0);
		expect(store.listLeases()).toHaveLength(0);
	});

	test("launch failure releases the port lease and records nothing", async () => {
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const { spawn } = spawnRecorder("fail");
		const result = await createAndroidProvider(deps(exec), { spawnDetached: spawn }).create("w", "pixel-10");
		expect(result.success).toBe(false);
		expect(store.listLeases()).toHaveLength(0);
		expect(store.listDevices("android")).toHaveLength(0);
	});

	test("all ports taken → err", async () => {
		for (let p = 5554; p <= 5584; p += 2)
			store.insertLease({ resource: { kind: "port", port: p }, owner, ttlMs: 1 }, 1);
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const { spawn, spawned } = spawnRecorder();
		const result = await createAndroidProvider(deps(exec), { spawnDetached: spawn }).create("w", "pixel-10");
		expect(result.success).toBe(false);
		expect(spawned).toHaveLength(0);
	});
});

describe("boot", () => {
	test("ok when already running, err otherwise", async () => {
		const { exec } = fakeExec({ [`${ADB} devices -l`]: out(ADB_DEVICES_MIXED) });
		const provider = createAndroidProvider(deps(exec));
		expect(await provider.boot("emulator-5554")).toEqual(ok(undefined));
		const missing = await provider.boot("emulator-5570");
		expect(missing.success).toBe(false);
		if (!missing.success) expect(missing.error).toContain("created, not booted");
	});
});

/** Virtual clock: `sleep` advances `now` instantly. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
	};
}

describe("waitReady", () => {
	test("polls sys.boot_completed until 1", async () => {
		let polls = 0;
		const { exec, calls } = fakeExec({
			[`${ADB} -s emulator-5554 wait-for-device`]: out(""),
			[`${ADB} -s emulator-5554 shell getprop sys.boot_completed`]: () => {
				polls++;
				return out(polls >= 3 ? "1\n" : "\n");
			},
		});
		const clock = fakeClock();
		const provider = createAndroidProvider(deps(exec, clock.now), { sleep: clock.sleep, pollIntervalMs: 1_000 });
		expect(await provider.waitReady("emulator-5554", 60_000)).toEqual(ok(undefined));
		expect(polls).toBe(3);
		expect(calls[0]).toBe(`${ADB} -s emulator-5554 wait-for-device`);
	});

	test("times out → err", async () => {
		const { exec } = fakeExec({
			[`${ADB} -s emulator-5554 wait-for-device`]: out(""),
			[`${ADB} -s emulator-5554 shell getprop sys.boot_completed`]: out("0\n"),
		});
		const clock = fakeClock();
		const provider = createAndroidProvider(deps(exec, clock.now), { sleep: clock.sleep, pollIntervalMs: 1_000 });
		const result = await provider.waitReady("emulator-5554", 5_000);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("timed out");
	});

	test("wait-for-device failure → err", async () => {
		const { exec } = fakeExec({ [`${ADB} -s emulator-5554 wait-for-device`]: fail("timeout") });
		const result = await createAndroidProvider(deps(exec), { sleep: async () => {} }).waitReady("emulator-5554", 1_000);
		expect(result.success).toBe(false);
	});
});

describe("shutdown", () => {
	test("refuses to kill a foreign emulator", async () => {
		const { exec, calls } = fakeExec({});
		const result = await createAndroidProvider(deps(exec)).shutdown("emulator-5554");
		expect(result).toEqual(err("refusing to shut down foreign emulator emulator-5554"));
		expect(calls).toHaveLength(0);
	});

	test("kills a warden emulator, releases its port lease, forgets the device", async () => {
		store.recordDevice({ platform: "android", id: "emulator-5556", name: "w", profile: "pixel-10" }, 1);
		store.insertLease({ resource: { kind: "port", port: 5556 }, owner, ttlMs: 1, label: "emulator w" }, 1);
		const other = store.insertLease(
			{ resource: { kind: "port", port: 5558 }, owner, ttlMs: 1, label: "emulator x" },
			1
		);
		const { exec, calls } = fakeExec({ [`${ADB} -s emulator-5556 emu kill`]: out("OK: killing emulator, bye bye\n") });
		expect(await createAndroidProvider(deps(exec)).shutdown("emulator-5556")).toEqual(ok(undefined));
		expect(calls).toEqual([`${ADB} -s emulator-5556 emu kill`]);
		expect(store.listLeases().map((l) => l.id)).toEqual([other.id]);
		expect(store.listDevices("android")).toHaveLength(0);
	});

	test("kill failure on a still-running emulator → err, bookkeeping kept", async () => {
		store.recordDevice({ platform: "android", id: "emulator-5554", name: "w" }, 1);
		store.insertLease({ resource: { kind: "port", port: 5554 }, owner, ttlMs: 1, label: "emulator w" }, 1);
		const { exec } = fakeExec({
			[`${ADB} -s emulator-5554 emu kill`]: fail("error: closed"),
			[`${ADB} devices -l`]: out(ADB_DEVICES_MIXED),
		});
		const result = await createAndroidProvider(deps(exec)).shutdown("emulator-5554");
		expect(result.success).toBe(false);
		expect(store.listLeases()).toHaveLength(1);
		expect(store.listDevices("android")).toHaveLength(1);
	});

	test("kill failure on an emulator that is already gone → cleans up", async () => {
		store.recordDevice({ platform: "android", id: "emulator-5570", name: "w" }, 1);
		store.insertLease({ resource: { kind: "port", port: 5570 }, owner, ttlMs: 1, label: "emulator w" }, 1);
		const { exec } = fakeExec({
			[`${ADB} -s emulator-5570 emu kill`]: fail("error: device 'emulator-5570' not found"),
			[`${ADB} devices -l`]: out(ADB_DEVICES_MIXED),
		});
		expect(await createAndroidProvider(deps(exec)).shutdown("emulator-5570")).toEqual(ok(undefined));
		expect(store.listLeases()).toHaveLength(0);
		expect(store.listDevices("android")).toHaveLength(0);
	});
});
