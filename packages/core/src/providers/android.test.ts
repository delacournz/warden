import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import { STAY_AWAKE_COMMAND, SYSTEMUI_RESTART_COMMAND, unlockCommand } from "../android-keyguard";
import { claimDevices } from "../claim";
import { DEFAULT_TTL_MS } from "../config.defaults";
import type { Exec, ExecOptions, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import type { InventoryDevice, Owner } from "../types";
import {
	androidTools,
	BOOT_WAIT_SCRIPT,
	bootSettingsCommand,
	classifyOther,
	createAndroidProvider,
	listAvds,
	PHONE_PROBE_SCRIPT,
	parseAdbDeviceList,
	parseAdbDevices,
	parseAvdList,
	pickConsolePort,
	type SpawnDetached,
	snapshotLoadFailed,
} from "./android";
import {
	ADB_DEVICES_EMPTY,
	ADB_DEVICES_MIXED,
	ADB_DEVICES_STATES,
	EMU_AVD_NAME_PIXEL_10,
	EMULATOR_LIST_AVDS,
	EMULATOR_PROPS,
	PHONE_PROPS,
} from "./android.fixtures";
import type { ProviderDeps } from "./provider.types";

const SDK = "/sdk";
const ADB = `${SDK}/platform-tools/adb`;
const EMULATOR = `${SDK}/emulator/emulator`;
const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };

type Handler = ExecResult | ((cmd: readonly string[], opts?: ExecOptions) => ExecResult | Promise<ExecResult>);

const out = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: "", stderr });

/** Fake exec: exact joined command → result. Unknown commands fail loudly. Records every call (and its options). */
function fakeExec(handlers: Record<string, Handler>): {
	exec: Exec;
	calls: string[];
	options: Map<string, ExecOptions | undefined>;
} {
	const calls: string[] = [];
	const options = new Map<string, ExecOptions | undefined>();
	const exec: Exec = async (cmd, opts) => {
		const key = cmd.join(" ");
		calls.push(key);
		options.set(key, opts);
		const handler = handlers[key];
		if (handler === undefined) return fail(`unexpected command: ${key}`);
		return typeof handler === "function" ? handler(cmd, opts) : handler;
	};
	return { exec, calls, options };
}

/** An exec that never finishes unless its signal aborts (then it exits 143, like a SIGTERM). */
const hang = (_cmd: readonly string[], opts?: ExecOptions): Promise<ExecResult> =>
	new Promise((resolve) => {
		opts?.signal?.addEventListener("abort", () => resolve({ exitCode: 143, stdout: "", stderr: "" }));
	});

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

	test("listAvds runs emulator -list-avds with a 15 s timeout (16-11)", async () => {
		const { exec, options } = fakeExec({ [`${EMULATOR} -list-avds`]: out(EMULATOR_LIST_AVDS) });
		expect(await listAvds(deps(exec))).toEqual(ok(["Pixel_10", "Pixel_9_Pro_Store"]));
		expect(options.get(`${EMULATOR} -list-avds`)?.timeoutMs).toBe(15_000);
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
	test("emulators with AVD name, profile, runtime; the phone is listed with physical info and no emu call", async () => {
		const { exec, calls } = fakeExec({
			[`${ADB} devices -l`]: out(ADB_DEVICES_MIXED),
			[`${ADB} -s R5CT1234ABC shell ${PHONE_PROBE_SCRIPT}`]: out(PHONE_PROPS),
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
				{
					platform: "android",
					id: "R5CT1234ABC",
					name: "SM-A546E",
					state: "booted",
					wardenCreated: false,
					profile: "sm-a546e",
					runtime: "android-34",
					physical: {
						platform: "android",
						transport: "usb",
						adbState: "device",
						hwSerial: "R5CT1234ABC",
						model: "SM-A546E",
					},
				},
			])
		);
		expect(calls.some((c) => c.includes("R5CT1234ABC") && c.includes(" emu "))).toBe(false);
	});

	test("warden-launched emulators use the recorded warden name", async () => {
		store.recordDevice({ platform: "android", id: "emulator-5554", name: "warden-pixel-10-1", profile: "pixel-10" }, 1);
		const { exec } = fakeExec({
			[`${ADB} devices -l`]: out(ADB_DEVICES_MIXED),
			[`${ADB} -s R5CT1234ABC shell ${PHONE_PROBE_SCRIPT}`]: out(PHONE_PROPS),
			[`${ADB} -s emulator-5554 emu avd name`]: out(EMU_AVD_NAME_PIXEL_10),
			[`${ADB} -s emulator-5554 shell getprop ro.build.version.sdk`]: out("35\n"),
			[`${ADB} -s emulator-5556 emu avd name`]: fail("error: device offline"),
		});
		const result = await createAndroidProvider(deps(exec)).inventory();
		if (!result.success) throw new Error(result.error);
		expect(result.data.map((d) => d.name)).toEqual(["warden-pixel-10-1", "emulator-5556", "SM-A546E"]);
		expect(result.data[0]?.wardenCreated).toBe(false);
	});

	test("console calls carry a 10 s timeout; a timed-out one reads as booting, no profile (16-11)", async () => {
		let t = 0;
		const { exec, options } = fakeExec({
			[`${ADB} devices -l`]: out("List of devices attached\nemulator-5554 device product:x\n"),
			[`${ADB} -s emulator-5554 emu avd name`]: () => {
				t += 10_000;
				return { exitCode: 143, stdout: "", stderr: "" };
			},
			[`${ADB} -s emulator-5554 shell getprop ro.build.version.sdk`]: out("35\n"),
		});
		const result = await createAndroidProvider(deps(exec, () => t)).inventory();
		expect(options.get(`${ADB} -s emulator-5554 emu avd name`)?.timeoutMs).toBe(10_000);
		expect(result).toEqual(
			ok([
				{
					platform: "android",
					id: "emulator-5554",
					name: "emulator-5554",
					state: "booting",
					wardenCreated: false,
					runtime: "android-35",
				},
			])
		);
	});

	test("an emulator on a golden-build port lease is marked golden (16-3)", async () => {
		store.insertLease(
			{ resource: { kind: "port", port: 5554 }, owner, ttlMs: 60_000, label: "emulator golden Pixel_10" },
			1
		);
		const { exec } = fakeExec({
			[`${ADB} devices -l`]: out(ADB_DEVICES_MIXED),
			[`${ADB} -s R5CT1234ABC shell ${PHONE_PROBE_SCRIPT}`]: out(PHONE_PROPS),
			[`${ADB} -s emulator-5554 emu avd name`]: out(EMU_AVD_NAME_PIXEL_10),
			[`${ADB} -s emulator-5554 shell getprop ro.build.version.sdk`]: out("35\n"),
			[`${ADB} -s emulator-5556 emu avd name`]: out("Pixel_9_Pro_Store\nOK\n"),
		});
		const result = await createAndroidProvider(deps(exec)).inventory();
		if (!result.success) throw new Error(result.error);
		expect(result.data.map((d) => d.golden === true)).toEqual([true, false, false]);
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
			"-no-audio",
			"-no-metrics",
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

	test("WARDEN_EMULATOR_AUDIO=1 keeps the emulator's audio (16-17)", async () => {
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const { spawn, spawned } = spawnRecorder();
		const audio = { ...deps(exec), env: { ANDROID_HOME: SDK, WARDEN_HOME: dir, WARDEN_EMULATOR_AUDIO: "1" } };
		await createAndroidProvider(audio, { spawnDetached: spawn }).create("w", "pixel-10");
		expect(spawned[0]?.cmd).not.toContain("-no-audio");
		expect(spawned[0]?.cmd).toContain("-no-metrics");
	});

	test("listAvds runs once per process, and create reuses the inventory's adb devices (16-14)", async () => {
		const { exec, calls } = fakeExec({
			...baseHandlers(ADB_DEVICES_EMPTY),
		});
		const { spawn } = spawnRecorder();
		const p = deps(exec);
		expect((await listAvds(p)).success).toBe(true);
		const provider = createAndroidProvider(p, { spawnDetached: spawn });
		expect((await provider.inventory()).success).toBe(true);
		expect((await provider.create("w", "pixel-10")).success).toBe(true);
		expect(calls.filter((c) => c === `${EMULATOR} -list-avds`)).toHaveLength(1);
		expect(calls.filter((c) => c === `${ADB} devices -l`)).toHaveLength(1);
	});

	test("an AVD the memoised list lacks is looked up once more before failing (16-14)", async () => {
		let lists = 0;
		const { exec } = fakeExec({
			[`${EMULATOR} -list-avds`]: () => (++lists === 1 ? out("Pixel_9_Pro_Store\n") : out(EMULATOR_LIST_AVDS)),
			[`${ADB} devices -l`]: out(ADB_DEVICES_EMPTY),
		});
		const { spawn } = spawnRecorder();
		const p = deps(exec);
		await listAvds(p);
		const result = await createAndroidProvider(p, { spawnDetached: spawn }).create("w", "pixel-10");
		expect(result.success).toBe(true);
		expect(lists).toBe(2);
	});

	test("launches from the snapshot the snapshot hook names (16-3)", async () => {
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const { spawn, spawned } = spawnRecorder();
		const asked: string[] = [];
		const provider = createAndroidProvider(deps(exec), {
			spawnDetached: spawn,
			snapshot: async (avd) => {
				asked.push(avd);
				return ok("warden-0123456789");
			},
		});
		expect((await provider.create("w", "pixel-10")).success).toBe(true);
		expect(asked).toEqual(["Pixel_10"]);
		expect(spawned[0]?.cmd).toEqual([
			EMULATOR,
			"-avd",
			"Pixel_10",
			"-port",
			"5554",
			"-no-window",
			"-read-only",
			"-snapshot",
			"warden-0123456789",
			"-no-snapshot-save",
			"-no-boot-anim",
			"-no-audio",
			"-no-metrics",
		]);
	});

	test("a launch from the snapshot that fails falls back to a cold boot once, and says so (16-3)", async () => {
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const spawned: Array<readonly string[]> = [];
		const spawn: SpawnDetached = async (cmd) => {
			spawned.push(cmd);
			return cmd.includes("-snapshot") ? err("emulator exited 1: snapshot load failed") : ok({ pid: 4242 });
		};
		const logs: string[] = [];
		const provider = createAndroidProvider(
			{ ...deps(exec), log: (line) => logs.push(line) },
			{ spawnDetached: spawn, snapshot: async () => ok("warden-0123456789") }
		);
		const result = await provider.create("w", "pixel-10");
		expect(result.success).toBe(true);
		expect(spawned).toHaveLength(2);
		expect(spawned[1]).not.toContain("-snapshot");
		expect(logs.join("\n")).toContain("cold boot");
		expect(store.findLeaseByResource({ kind: "port", port: 5554 })).toBeDefined();
	});

	test("no snapshot (hook says none, or fails) → today's cold-boot argv (16-3)", async () => {
		for (const answer of [ok(undefined), err("no SDK")] as const) {
			const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
			const { spawn, spawned } = spawnRecorder();
			const provider = createAndroidProvider(deps(exec), { spawnDetached: spawn, snapshot: async () => answer });
			expect((await provider.create("w", "pixel-10")).success).toBe(true);
			expect(spawned[0]?.cmd).not.toContain("-snapshot");
			store.deleteLeases(store.listLeases().map((l) => l.id));
		}
	});

	test("an emulator that rejects -no-audio/-no-metrics is relaunched once without them (R6)", async () => {
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const spawned: Array<readonly string[]> = [];
		const spawn: SpawnDetached = async (cmd) => {
			spawned.push(cmd);
			return cmd.includes("-no-metrics")
				? err(
						"`emulator -avd Pixel_10 …` exited 1: emulator: ERROR: Invalid command-line parameter: -no-metrics. | Hint: use '@foo' to launch a virtual device named 'foo'. (log: x)"
					)
				: ok({ pid: 4242 });
		};
		const logs: string[] = [];
		const provider = createAndroidProvider(
			{ ...deps(exec), log: (line) => logs.push(line) },
			{ spawnDetached: spawn, snapshot: async () => ok("warden-0123456789") }
		);
		expect((await provider.create("w", "pixel-10")).success).toBe(true);
		expect(spawned).toHaveLength(2);
		expect(spawned[1]).toContain("-snapshot");
		expect(spawned[1]).not.toContain("-no-metrics");
		expect(spawned[1]).not.toContain("-no-audio");
		expect(logs.join("\n")).toContain("without them");
	});

	test("any other early exit is not retried without the flags (R6)", async () => {
		const { exec } = fakeExec(baseHandlers(ADB_DEVICES_EMPTY));
		const spawned: Array<readonly string[]> = [];
		const spawn: SpawnDetached = async (cmd) => {
			spawned.push(cmd);
			return err("emulator exited 1: FATAL | another emulator instance is running");
		};
		const result = await createAndroidProvider(deps(exec), { spawnDetached: spawn }).create("w", "pixel-10");
		expect(result.success).toBe(false);
		expect(spawned).toHaveLength(1);
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

describe("snapshotLoadFailed (R5, R9)", () => {
	const LOADED = [
		"INFO    | Android emulator version 35.4.9.0 (build_id 13025442) (CL:N/A)",
		"INFO    | Loading snapshot 'warden-0123456789'...",
		"INFO    | Successfully loaded snapshot 'warden-0123456789' using 812 ms",
		"INFO    | Boot completed in 2104 ms",
		"WARNING | cannot add library vulkan-1: failed",
	].join("\n");

	test("a log of a successful load is not a failure", () => {
		expect(snapshotLoadFailed(LOADED)).toBe(false);
	});

	test("the emulator's load failures are", () => {
		for (const line of [
			"WARNING | Failed to load snapshot 'warden-0123456789'",
			"WARNING | Device 'cache' does not have the requested snapshot 'warden-0123456789'",
			"ERROR   | Snapshot 'warden-0123456789' could not be loaded: incompatible",
			"qemu-system-aarch64: Could not open snapshot 'warden-0123456789'",
		])
			expect(snapshotLoadFailed(`${LOADED}\n${line}\nINFO    | Cold boot: requested by the user`)).toBe(true);
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

describe("boot right after create (16-4)", () => {
	const ADB_DEVICES_5554 = "List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64\n";

	test("a warden emulator not yet registered with adb is polled for, not failed", async () => {
		store.recordDevice({ platform: "android", id: "emulator-5554", name: "warden-pixel-10-1" }, 1);
		let listed = 0;
		const { exec } = fakeExec({
			[`${ADB} devices -l`]: () => (++listed >= 3 ? out(ADB_DEVICES_5554) : out(ADB_DEVICES_EMPTY)),
		});
		const slept: number[] = [];
		const provider = createAndroidProvider(deps(exec), { sleep: async (ms) => void slept.push(ms) });
		expect(await provider.boot("emulator-5554")).toEqual(ok(undefined));
		expect(listed).toBe(3);
		expect(slept).toEqual([250, 250]);
	});

	test("gives up after ~15 s when the warden emulator never registers", async () => {
		store.recordDevice({ platform: "android", id: "emulator-5554", name: "warden-pixel-10-1" }, 1);
		const { exec, calls } = fakeExec({ [`${ADB} devices -l`]: out(ADB_DEVICES_EMPTY) });
		const slept: number[] = [];
		const provider = createAndroidProvider(deps(exec), { sleep: async (ms) => void slept.push(ms) });
		const result = await provider.boot("emulator-5554");
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("did not register with adb");
		expect(slept.reduce((a, b) => a + b, 0)).toBe(15_000);
		expect(calls.length).toBe(61);
	});

	test("a claim of a fresh emulator succeeds when adb lists it only after a few polls", async () => {
		let listed = 0;
		const { exec } = fakeExec({
			[`${EMULATOR} -list-avds`]: out(EMULATOR_LIST_AVDS),
			// 1: claim inventory (create reuses it), 2-3: boot polls miss, 4: registered
			[`${ADB} devices -l`]: () => (++listed >= 4 ? out(ADB_DEVICES_5554) : out(ADB_DEVICES_EMPTY)),
			[`${ADB} -s emulator-5554 wait-for-device shell ${BOOT_WAIT_SCRIPT}`]: out(""),
		});
		const spawnDetached: SpawnDetached = async () => ok({ pid: 4242 });
		const provider = createAndroidProvider(deps(exec), { spawnDetached, sleep: async () => {}, pidAlive: () => true });
		const result = await claimDevices({
			store,
			provider,
			owner,
			request: { platform: "android", profile: "pixel-10", count: 1, max: 1 },
			ttlMs: 60_000,
			now: () => 1_000,
			pidAlive: () => false,
			waitMs: 0,
			sleep: async () => {},
		});
		expect(result.success && result.data.claimed.map((c) => [c.action, c.device.id])).toEqual([
			["create", "emulator-5554"],
		]);
		expect(listed).toBe(4);
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
	const WAIT = `${ADB} -s emulator-5554 wait-for-device shell ${BOOT_WAIT_SCRIPT}`;

	test("one adb call waits for the device and boot_completed, bounded by the budget (16-5)", async () => {
		const { exec, calls, options } = fakeExec({ [WAIT]: out("") });
		const clock = fakeClock();
		const provider = createAndroidProvider(deps(exec, clock.now), { sleep: clock.sleep });
		expect(await provider.waitReady("emulator-5554", 60_000)).toEqual(ok(undefined));
		expect(calls[0]).toBe(WAIT);
		expect(options.get(WAIT)?.timeoutMs).toBe(60_000);
	});

	test("the shell loop failing (adbd restart) falls back to polling sys.boot_completed until 1", async () => {
		let polls = 0;
		const { exec, calls, options } = fakeExec({
			[WAIT]: fail("error: closed"),
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
		expect(calls[1]).toBe(`${ADB} -s emulator-5554 wait-for-device`);
		expect(options.get(`${ADB} -s emulator-5554 shell getprop sys.boot_completed`)?.timeoutMs).toBe(5_000);
	});

	test("the fallback poll is 250 ms by default", async () => {
		let polls = 0;
		const { exec } = fakeExec({
			[WAIT]: fail("error: closed"),
			[`${ADB} -s emulator-5554 wait-for-device`]: out(""),
			[`${ADB} -s emulator-5554 shell getprop sys.boot_completed`]: () => out(++polls >= 2 ? "1\n" : "0\n"),
		});
		const slept: number[] = [];
		const provider = createAndroidProvider(deps(exec), { sleep: async (ms) => void slept.push(ms) });
		expect(await provider.waitReady("emulator-5554", 60_000)).toEqual(ok(undefined));
		expect(slept).toContain(250);
		expect(slept).not.toContain(2_000);
	});

	test("times out → err", async () => {
		const { exec } = fakeExec({
			[WAIT]: fail("error: closed"),
			[`${ADB} -s emulator-5554 wait-for-device`]: out(""),
			[`${ADB} -s emulator-5554 shell getprop sys.boot_completed`]: out("0\n"),
		});
		const clock = fakeClock();
		const provider = createAndroidProvider(deps(exec, clock.now), { sleep: clock.sleep, pollIntervalMs: 1_000 });
		const result = await provider.waitReady("emulator-5554", 5_000);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("timed out");
	});

	test("applies the boot settings once booted", async () => {
		const settings = `${ADB} -s emulator-5554 shell ${bootSettingsCommand()}`;
		const { exec, calls } = fakeExec({ [WAIT]: out(""), [settings]: out("") });
		const provider = createAndroidProvider(deps(exec), { sleep: async () => {} });
		expect(await provider.waitReady("emulator-5554", 60_000)).toEqual(ok(undefined));
		expect(calls).toEqual([WAIT, settings, `${ADB} -s emulator-5554 shell dumpsys window`]);
	});

	const BIO_STATE = `${ADB} -s emulator-5554 get-state`;
	const BIO_PM = `${ADB} -s emulator-5554 shell pm path android`;
	const BIO_DUMP = `${ADB} -s emulator-5554 shell dumpsys window`;
	const BIO_UNLOCK = `${ADB} -s emulator-5554 shell ${unlockCommand()}`;
	const BIO_AWAKE = `${ADB} -s emulator-5554 shell ${STAY_AWAKE_COMMAND}`;
	const BIO_KILL = `${ADB} -s emulator-5554 emu kill`;

	/** a +bio emulator created by this provider, its adb answers from `handlers` */
	async function bioProvider(handlers: Record<string, Handler>) {
		const settings = `${ADB} -s emulator-5554 shell ${bootSettingsCommand()}`;
		const fake = fakeExec({
			[`${EMULATOR} -list-avds`]: out(EMULATOR_LIST_AVDS),
			[`${ADB} devices -l`]: out(ADB_DEVICES_EMPTY),
			[WAIT]: out(""),
			[settings]: out(""),
			[BIO_STATE]: out("device\n"),
			[BIO_PM]: out("package:/system/framework/framework-res.apk\n"),
			...handlers,
		});
		const spawn: SpawnDetached = async () => ok({ pid: 4242 });
		const snapshot = async () => ok("warden-0123456789");
		const provider = createAndroidProvider(deps(fake.exec), {
			sleep: async () => {},
			pidAlive: () => true,
			spawnDetached: spawn,
			snapshot,
		});
		expect((await provider.create("w", "pixel-10+bio")).success).toBe(true);
		return { provider, ...fake };
	}

	test("a biometrics emulator waits for adb + the package manager, gets past the keyguard, then re-checks", async () => {
		let dumps = 0;
		const { provider, calls } = await bioProvider({
			[BIO_DUMP]: () => out(++dumps === 1 ? "isKeyguardShowing=true" : "isKeyguardShowing=false"),
			[BIO_UNLOCK]: out(""),
			[BIO_AWAKE]: out(""),
		});
		expect(await provider.waitReady("emulator-5554", 60_000)).toEqual(ok(undefined));
		const order = [BIO_STATE, BIO_PM, BIO_DUMP, BIO_UNLOCK, BIO_DUMP, BIO_AWAKE, BIO_STATE, BIO_PM];
		expect(calls.filter((c) => order.includes(c))).toEqual(order);
		expect(calls).not.toContain(BIO_KILL);
	});

	test("a plain emulator is not unlocked", async () => {
		const wait = `${ADB} -s emulator-5560 wait-for-device shell ${BOOT_WAIT_SCRIPT}`;
		const plainSettings = `${ADB} -s emulator-5560 shell ${bootSettingsCommand()}`;
		const plain = fakeExec({ [wait]: out(""), [plainSettings]: out("") });
		const other = createAndroidProvider(deps(plain.exec), { sleep: async () => {} });
		expect(await other.waitReady("emulator-5560", 60_000)).toEqual(ok(undefined));
		expect(plain.calls).toEqual([wait, plainSettings, `${ADB} -s emulator-5560 shell dumpsys window`]);
		expect(plain.calls.some((c) => c.includes("input"))).toBe(false);
	});

	test("a plain emulator restored behind the lock screen is unlocked (the app cannot resolve its launcher otherwise)", async () => {
		let dumps = 0;
		const wait = `${ADB} -s emulator-5560 wait-for-device shell ${BOOT_WAIT_SCRIPT}`;
		const plainSettings = `${ADB} -s emulator-5560 shell ${bootSettingsCommand()}`;
		const dump = `${ADB} -s emulator-5560 shell dumpsys window`;
		const unlock = `${ADB} -s emulator-5560 shell ${unlockCommand()}`;
		const awake = `${ADB} -s emulator-5560 shell ${STAY_AWAKE_COMMAND}`;
		const plain = fakeExec({
			[wait]: out(""),
			[plainSettings]: out(""),
			[dump]: () => out(++dumps <= 2 ? "isKeyguardShowing=true" : "isKeyguardShowing=false"),
			[unlock]: out(""),
			[awake]: out(""),
		});
		const other = createAndroidProvider(deps(plain.exec), { sleep: async () => {} });
		expect(await other.waitReady("emulator-5560", 60_000)).toEqual(ok(undefined));
		expect(plain.calls).toContain(unlock);
		expect(plain.calls).toContain(awake);
	});

	test("a plain emulator that stays locked is still ready, never discarded", async () => {
		const wait = `${ADB} -s emulator-5560 wait-for-device shell ${BOOT_WAIT_SCRIPT}`;
		const plain = fakeExec({
			[wait]: out(""),
			[`${ADB} -s emulator-5560 shell ${bootSettingsCommand()}`]: out(""),
			[`${ADB} -s emulator-5560 shell dumpsys window`]: out("isKeyguardShowing=true"),
		});
		const other = createAndroidProvider(deps(plain.exec), { sleep: async () => {} });
		expect(await other.waitReady("emulator-5560", 60_000)).toEqual(ok(undefined));
		expect(plain.calls.some((c) => c.includes("emu kill"))).toBe(false);
	});

	test("a biometrics emulator stuck on its keyguard fails readiness and is shut down, not left locked", async () => {
		const { provider, calls } = await bioProvider({
			[BIO_DUMP]: out("isKeyguardShowing=true"),
			[BIO_UNLOCK]: out(""),
			[`${ADB} -s emulator-5554 shell ${SYSTEMUI_RESTART_COMMAND}`]: out(""),
			[BIO_KILL]: out(""),
			[`${ADB} devices -l`]: out(ADB_DEVICES_EMPTY),
		});
		const result = await provider.waitReady("emulator-5554", 60_000);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("keyguard");
		expect(calls).toContain(BIO_KILL);
		expect(store.listDevices("android")).toEqual([]);
	});

	test("a foreign emulator that fails readiness is never shut down", async () => {
		const wait = `${ADB} -s emulator-5562 wait-for-device shell ${BOOT_WAIT_SCRIPT}`;
		const { exec, calls } = fakeExec({
			[wait]: fail("error: closed"),
			[`${ADB} -s emulator-5562 wait-for-device`]: out(""),
			[`${ADB} -s emulator-5562 shell getprop sys.boot_completed`]: out("0\n"),
		});
		const clock = fakeClock();
		const provider = createAndroidProvider(deps(exec, clock.now), { sleep: clock.sleep, pollIntervalMs: 1_000 });
		expect((await provider.waitReady("emulator-5562", 3_000)).success).toBe(false);
		expect(calls.some((c) => c.includes("emu kill"))).toBe(false);
	});

	test("a failing settings put does not fail readiness", async () => {
		const settings = `${ADB} -s emulator-5554 shell ${bootSettingsCommand()}`;
		const { exec, calls } = fakeExec({ [WAIT]: out(""), [settings]: fail("boom") });
		const provider = createAndroidProvider(deps(exec), { sleep: async () => {} });
		expect(await provider.waitReady("emulator-5554", 1_000)).toEqual(ok(undefined));
		expect(calls).toContain(settings);
	});

	test("times out → no settings call", async () => {
		const { exec, calls } = fakeExec({
			[WAIT]: fail("error: closed"),
			[`${ADB} -s emulator-5554 wait-for-device`]: out(""),
			[`${ADB} -s emulator-5554 shell getprop sys.boot_completed`]: out("0\n"),
		});
		const clock = fakeClock();
		const provider = createAndroidProvider(deps(exec, clock.now), { sleep: clock.sleep, pollIntervalMs: 1_000 });
		const result = await provider.waitReady("emulator-5554", 3_000);
		expect(result.success).toBe(false);
		expect(calls.some((c) => c.includes("settings put"))).toBe(false);
	});

	test("a hung adb (never returns) ends at the deadline, and the call is aborted (16-5)", async () => {
		let aborted = false;
		const { exec } = fakeExec({
			[WAIT]: (cmd, opts) => {
				opts?.signal?.addEventListener("abort", () => {
					aborted = true;
				});
				return hang(cmd, opts);
			},
		});
		const clock = fakeClock();
		const provider = createAndroidProvider(deps(exec, clock.now), { sleep: clock.sleep });
		const result = await provider.waitReady("emulator-5554", 5_000);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("timed out");
		expect(clock.now()).toBeLessThanOrEqual(5_500);
		expect(aborted).toBe(true);
	});

	test("an emulator that dies while booting fails at once with its log tail (16-5)", async () => {
		const { exec } = fakeExec({
			[`${EMULATOR} -list-avds`]: out(EMULATOR_LIST_AVDS),
			[`${ADB} devices -l`]: out(ADB_DEVICES_EMPTY),
			[WAIT]: hang,
		});
		mkdirSync(join(dir, "logs"), { recursive: true });
		writeFileSync(join(dir, "logs", "emulator-5554.log"), "INFO | booting\nFATAL | HVF error: HV_ERROR\n");
		let alive = true;
		const clock = fakeClock();
		const provider = createAndroidProvider(deps(exec, clock.now), {
			sleep: async (ms) => {
				await clock.sleep(ms);
				if (clock.now() >= 1_000) alive = false;
			},
			spawnDetached: async () => ok({ pid: 4242 }),
			pidAlive: (pid) => pid === 4242 && alive,
		});
		expect((await provider.create("warden-pixel-10-1", "pixel-10")).success).toBe(true);
		const result = await provider.waitReady("emulator-5554", 300_000);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("exited");
			expect(result.error).toContain("HVF error");
		}
		expect(clock.now()).toBeLessThan(2_000);
	});

	test("a device that cannot be found at all → err", async () => {
		const { exec } = fakeExec({
			[WAIT]: fail("error: device not found"),
			[`${ADB} -s emulator-5554 wait-for-device`]: fail("timeout"),
		});
		const result = await createAndroidProvider(deps(exec), { sleep: async () => {} }).waitReady("emulator-5554", 1_000);
		expect(result.success).toBe(false);
	});
});

describe("bootSettingsCommand", () => {
	test("is the exact three-put shell line", () => {
		expect(bootSettingsCommand()).toBe(
			"settings put global package_verifier_user_consent -1; settings put global verifier_verify_adb_installs 0; settings put global package_verifier_enable 0"
		);
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
		const { exec, calls, options } = fakeExec({
			[`${ADB} -s emulator-5556 emu kill`]: out("OK: killing emulator, bye bye\n"),
		});
		expect(await createAndroidProvider(deps(exec)).shutdown("emulator-5556")).toEqual(ok(undefined));
		expect(calls).toEqual([`${ADB} -s emulator-5556 emu kill`]);
		expect(options.get(`${ADB} -s emulator-5556 emu kill`)?.timeoutMs).toBe(10_000);
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

describe("parseAdbDeviceList", () => {
	test("classifies emulators and everything else, with multi-word states and transports", () => {
		const entries = parseAdbDeviceList(ADB_DEVICES_STATES);
		expect(entries).toEqual([
			{
				kind: "other",
				serial: "R5CT1234ABC",
				state: "device",
				transport: "usb",
				model: "SM_A546E",
				product: "a54xnaeea",
			},
			{ kind: "other", serial: "0123456789ABCDEF", state: "unauthorized", transport: "usb" },
			{ kind: "other", serial: "FA7AB1234567", state: "no permissions", transport: "usb" },
			{
				kind: "other",
				serial: "192.168.1.20:5555",
				state: "device",
				transport: "wifi",
				model: "Pixel_8_Pro",
				product: "husky",
			},
			{
				kind: "other",
				serial: "adb-R5CT9999-abcdef._adb-tls-connect._tcp",
				state: "device",
				transport: "wifi",
				model: "SM_S901",
				product: "b",
			},
			{
				kind: "other",
				serial: "localhost:5555",
				state: "device",
				transport: "wifi",
				model: "Genymotion",
				product: "vbox86p",
			},
			{ kind: "other", serial: "ZY22OFFLINE", state: "offline", transport: "usb" },
			{ kind: "other", serial: "HEADROOM1", state: "recovery", transport: "usb" },
			{ kind: "emulator", serial: "emulator-5554", port: 5554, state: "device" },
		]);
	});

	test("parseAdbDevices stays emulator-only", () => {
		expect(parseAdbDevices(ADB_DEVICES_STATES)).toEqual([{ serial: "emulator-5554", port: 5554, state: "device" }]);
	});

	test("skips the header, daemon noise and blank lines", () => {
		const text =
			"* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\n";
		expect(parseAdbDeviceList(text)).toEqual([]);
	});
});

describe("classifyOther", () => {
	test("one bounded shell reads qemu props, serial, model, sdk; a real phone is not an emulator", async () => {
		const { exec, calls, options } = fakeExec({
			[`${ADB} -s R5CT1234ABC shell ${PHONE_PROBE_SCRIPT}`]: out(PHONE_PROPS),
		});
		const result = await classifyOther(deps(exec), "R5CT1234ABC");
		expect(result).toEqual(ok({ emulator: false, hwSerial: "R5CT1234ABC", model: "SM-A546E", sdk: "34" }));
		expect(calls).toHaveLength(1);
		expect(options.get(calls[0] ?? "")?.timeoutMs).toBe(5_000);
	});

	test("qemu=1 (Genymotion, localhost:5555) is a foreign emulator", async () => {
		const { exec } = fakeExec({ [`${ADB} -s localhost:5555 shell ${PHONE_PROBE_SCRIPT}`]: out(EMULATOR_PROPS) });
		const result = await classifyOther(deps(exec), "localhost:5555");
		expect(result.success && result.data.emulator).toBe(true);
	});

	test("a failed read is an error, never a guess", async () => {
		const { exec } = fakeExec({});
		expect((await classifyOther(deps(exec), "X")).success).toBe(false);
	});
});

function adbStateOf(device: InventoryDevice | undefined): string | undefined {
	const physical = device?.physical;
	return physical?.platform === "android" ? physical.adbState : undefined;
}

describe("physical phones", () => {
	const PHONE = "R5CT1234ABC";
	const phoneHandlers = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
		[`${ADB} devices -l`]: out(ADB_DEVICES_STATES),
		[`${ADB} -s ${PHONE} shell ${PHONE_PROBE_SCRIPT}`]: out(PHONE_PROPS),
		[`${ADB} -s 192.168.1.20:5555 shell ${PHONE_PROBE_SCRIPT}`]: out("\n\nWIFI1\nPixel 8 Pro\n35\n"),
		[`${ADB} -s adb-R5CT9999-abcdef._adb-tls-connect._tcp shell ${PHONE_PROBE_SCRIPT}`]:
			out("\n\nR5CT9999\nSM-S901\n33\n"),
		[`${ADB} -s localhost:5555 shell ${PHONE_PROBE_SCRIPT}`]: out(EMULATOR_PROPS),
		[`${ADB} -s emulator-5554 emu avd name`]: out(EMU_AVD_NAME_PIXEL_10),
		[`${ADB} -s emulator-5554 shell getprop ro.build.version.sdk`]: out("35\n"),
		...extra,
	});

	test("inventory lists phones per adb state; non-ready ones are booting; a network emulator is not physical", async () => {
		const { exec, calls } = fakeExec(phoneHandlers());
		const result = await createAndroidProvider(deps(exec)).inventory();
		if (!result.success) throw new Error(result.error);
		const byId = new Map(result.data.map((d) => [d.id, d]));
		expect(byId.get(PHONE)?.state).toBe("booted");
		expect(byId.get(PHONE)?.physical).toEqual({
			platform: "android",
			transport: "usb",
			adbState: "device",
			hwSerial: PHONE,
			model: "SM-A546E",
		});
		expect(byId.get("0123456789ABCDEF")).toMatchObject({
			state: "booting",
			physical: { adbState: "unauthorized", transport: "usb" },
		});
		expect(adbStateOf(byId.get("FA7AB1234567"))).toBe("no permissions");
		expect(adbStateOf(byId.get("ZY22OFFLINE"))).toBe("offline");
		expect(byId.get("192.168.1.20:5555")).toMatchObject({
			name: "Pixel 8 Pro",
			physical: { transport: "wifi" },
			runtime: "android-35",
		});
		expect(byId.get("adb-R5CT9999-abcdef._adb-tls-connect._tcp")?.physical?.transport).toBe("wifi");
		expect(byId.get("localhost:5555")?.physical).toBeUndefined();
		expect(byId.get("localhost:5555")?.wardenCreated).toBe(false);
		expect(byId.get("emulator-5554")?.physical).toBeUndefined();
		// unauthorized/offline phones cannot answer getprop: never asked
		expect(calls.some((c) => c.includes("0123456789ABCDEF shell"))).toBe(false);
		expect(calls.some((c) => c.includes("ZY22OFFLINE shell"))).toBe(false);
	});

	test("boot refuses a phone; an unauthorized one says to accept the USB debugging prompt", async () => {
		const { exec } = fakeExec(phoneHandlers());
		const provider = createAndroidProvider(deps(exec));
		const unauthorized = await provider.boot("0123456789ABCDEF");
		expect(!unauthorized.success && unauthorized.error).toContain("USB debugging prompt");
		const ready = await provider.boot(PHONE);
		expect(ready.success).toBe(false);
	});

	test("shutdown refuses a phone, even one recorded as a warden device", async () => {
		store.recordDevice({ platform: "android", id: PHONE, name: "x" }, 1);
		const { exec, calls } = fakeExec(phoneHandlers());
		const result = await createAndroidProvider(deps(exec)).shutdown(PHONE);
		expect(!result.success && result.error).toContain("physical");
		expect(calls.filter((c) => c.includes(PHONE))).toEqual([]);
	});

	test("waitReady waits for boot_completed and never applies BOOT_SETTINGS; verifyWarm is one getprop", async () => {
		const { exec, calls } = fakeExec(
			phoneHandlers({
				[`${ADB} -s ${PHONE} wait-for-device shell ${BOOT_WAIT_SCRIPT}`]: out(""),
				[`${ADB} -s ${PHONE} shell getprop sys.boot_completed`]: out("1\n"),
			})
		);
		const provider = createAndroidProvider(deps(exec));
		expect((await provider.waitReady(PHONE, 5_000)).success).toBe(true);
		expect(await provider.verifyWarm?.(PHONE)).toEqual(ok(undefined));
		expect(calls.some((c) => c.includes("settings put"))).toBe(false);
	});

	test("verifyWarm fails (full path) when the phone is not booted, and for emulators", async () => {
		const { exec } = fakeExec(phoneHandlers({ [`${ADB} -s ${PHONE} shell getprop sys.boot_completed`]: out("\n") }));
		const provider = createAndroidProvider(deps(exec));
		expect((await provider.verifyWarm?.(PHONE))?.success).toBe(false);
		expect((await provider.verifyWarm?.("emulator-5554"))?.success).toBe(false);
	});

	test("no emu, settings put global package_verifier*, or kill argv ever reaches a phone serial", async () => {
		const phones = [PHONE, "0123456789ABCDEF", "192.168.1.20:5555", "ZY22OFFLINE"];
		const { exec, calls } = fakeExec(
			phoneHandlers({
				[`${ADB} -s ${PHONE} wait-for-device shell ${BOOT_WAIT_SCRIPT}`]: out(""),
				[`${ADB} -s ${PHONE} shell getprop sys.boot_completed`]: out("1\n"),
			})
		);
		const provider = createAndroidProvider(deps(exec));
		await provider.inventory();
		for (const id of phones) {
			await provider.boot(id);
			await provider.shutdown(id);
		}
		await provider.waitReady(PHONE, 1_000);
		await provider.verifyWarm?.(PHONE);
		const toPhones = calls.filter((c) => phones.some((id) => c.includes(` ${id} `) || c.endsWith(` ${id}`)));
		expect(toPhones.length).toBeGreaterThan(0);
		for (const call of toPhones) {
			expect(call).not.toMatch(/\bemu\b|package_verifier|verifier_verify|settings put|kill/);
		}
	});
});
