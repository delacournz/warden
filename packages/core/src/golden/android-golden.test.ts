import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { claimDevices } from "../claim";
import type { Exec, ExecResult } from "../exec";
import { BOOT_WAIT_SCRIPT, createAndroidProvider, GOLDEN_PORT_LABEL, type SpawnDetached } from "../providers/android";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import {
	type AndroidGoldenDeps,
	type AndroidSnapshotInputs,
	androidSnapshotEnabled,
	androidSnapshotKey,
	avdHome,
	buildPendingAndroidSnapshot,
	ensureAndroidSnapshot,
	explicitAndroidSnapshot,
	invalidateAndroidSnapshot,
	listAndroidSnapshots,
	parseEmulatorVersion,
	parseProperties,
	pruneAndroidSnapshots,
	readSnapshotInputs,
	snapshotForClaim,
	snapshotName,
} from "./android-golden";
import {
	ANDROID_SNAPSHOT_RETRY_MS,
	androidSnapshotLoaded,
	androidSnapshotsDue,
	androidSnapshotsGivenUp,
	markAndroidSnapshotPending,
	pendingAndroidSnapshots,
} from "./android-snapshot-pending";

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };
const SYSDIR = "system-images/android-36/google_apis/arm64-v8a/";
const CONFIG_INI = `AvdId=Pixel_10
hw.cpu.ncore=4
hw.ramSize=4096
hw.lcd.density=420
image.sysdir.1=${SYSDIR}
disk.dataPartition.size=6G
`;

const out = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: "", stderr });

let dir: string;
let sdk: string;
let avdHomeDir: string;
let store: Store;

function writeAvd(name: string, config = CONFIG_INI): string {
	const avdPath = join(avdHomeDir, `${name}.avd`);
	mkdirSync(avdPath, { recursive: true });
	writeFileSync(join(avdHomeDir, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${avdPath}\n`);
	writeFileSync(join(avdPath, "config.ini"), config);
	return avdPath;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-android-golden-"));
	sdk = join(dir, "sdk");
	avdHomeDir = join(dir, "avd");
	mkdirSync(join(sdk, "emulator"), { recursive: true });
	writeFileSync(join(sdk, "emulator", "source.properties"), "Pkg.Desc=Android Emulator\nPkg.Revision=35.4.9\n");
	mkdirSync(join(sdk, SYSDIR), { recursive: true });
	writeFileSync(join(sdk, SYSDIR, "source.properties"), "Pkg.Revision=5\nAndroidVersion.ApiLevel=36\n");
	writeFileSync(
		join(sdk, SYSDIR, "build.prop"),
		"ro.build.fingerprint=google/sdk_gphone64_arm64/emu64a:16/BP22/1:userdebug/dev-keys\n"
	);
	writeAvd("Pixel_10");
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const ADB = () => join(sdk, "platform-tools", "adb");
const EMULATOR = () => join(sdk, "emulator", "emulator");
const env = () => ({ ANDROID_HOME: sdk, ANDROID_AVD_HOME: avdHomeDir, WARDEN_HOME: dir });

/** `command` = what `ps -o command=` prints for its pid (default: an Android Studio launch of `avd`) */
type Instance = { avd: string; pid: number; writable: boolean; command?: string };

type HostOptions = {
	avds?: string[];
	snapshotLaunchFails?: boolean;
	/** `emu kill` answers OK but the process stays (only SIGKILL ends it) */
	killIgnored?: boolean;
	/** the writable build instance never reaches boot_completed */
	buildNeverBoots?: boolean;
	/** the writable build instance dies right after its launch */
	buildDies?: boolean;
	/** also ignore SIGKILL */
	unkillable?: boolean;
};

/**
 * Stateful fake adb + emulator: a spawned emulator is listed by `adb devices` at once, boots at once,
 * `emu avd snapshot save` writes the snapshot dir (like the real console, into the AVD's `snapshots/`),
 * `emu kill` ends the process.
 */
function fakeAndroidHost(opts: HostOptions = {}) {
	const running = new Map<string, Instance>();
	const spawned: Array<readonly string[]> = [];
	const calls: string[] = [];
	const kills: Array<[number, string]> = [];
	/** live processes that are not emulators (a pid reused after an emulator exited) */
	const processes = new Map<number, string>();
	let nextPid = 100;
	const avds = opts.avds ?? ["Pixel_10"];

	const exec: Exec = async (cmd) => {
		const key = cmd.join(" ");
		calls.push(key);
		if (key === `${EMULATOR()} -list-avds`) return out(`${avds.join("\n")}\n`);
		const ps = /^ps -o command= -p (\d+)$/.exec(key);
		if (ps) return psCommand(Number(ps[1]));
		if (key === `${ADB()} devices -l`) {
			const lines = [...running.keys()].map((s) => `${s}          device product:sdk_gphone64_arm64`);
			return out(`List of devices attached\n${lines.join("\n")}\n`);
		}
		const match = /^\S+ -s (emulator-\d+) (.*)$/.exec(key);
		const serial = match?.[1];
		const instance = serial !== undefined ? running.get(serial) : undefined;
		if (serial === undefined || instance === undefined) return fail(`error: device '${serial}' not found`);
		return deviceCommand(serial, instance, match?.[2] ?? "") ?? fail(`unexpected command: ${key}`);
	};

	function psCommand(pid: number): ExecResult {
		const instance = [...running.values()].find((i) => i.pid === pid);
		const command =
			instance !== undefined
				? (instance.command ?? `${EMULATOR()} -netdelay none -netspeed full -avd ${instance.avd} -qt-hide-window`)
				: processes.get(pid);
		return command !== undefined ? out(`${command}\n`) : fail("");
	}

	function save(instance: Instance, name: string): ExecResult {
		if (!instance.writable) return out("KO: snapshot save is not allowed for read-only instances\r\n");
		const snap = join(avdHomeDir, `${instance.avd}.avd`, "snapshots", name);
		mkdirSync(snap, { recursive: true });
		writeFileSync(join(snap, "snapshot.pb"), "pb");
		return out("OK\r\n");
	}

	function kill(serial: string): ExecResult {
		if (!opts.killIgnored) running.delete(serial);
		return out("OK: killing emulator, bye bye\r\n");
	}

	function deviceCommand(serial: string, instance: Instance, rest: string): ExecResult | undefined {
		const hangs = instance.writable && opts.buildNeverBoots === true;
		const fixed: Record<string, () => ExecResult> = {
			"emu avd name": () => out(`${instance.avd}\r\nOK\r\n`),
			[`wait-for-device shell ${BOOT_WAIT_SCRIPT}`]: () => (hangs ? fail("error: closed") : out("")),
			"wait-for-device": () => out(""),
			"shell getprop sys.boot_completed": () => out(hangs ? "\n" : "1\n"),
			"shell getprop ro.build.version.sdk": () => out("36\n"),
			"emu kill": () => kill(serial),
		};
		const name = /^emu avd snapshot save (\S+)$/.exec(rest)?.[1];
		return name !== undefined ? save(instance, name) : fixed[rest]?.();
	}

	const spawnDetached: SpawnDetached = async (cmd) => {
		spawned.push(cmd);
		if (opts.snapshotLaunchFails && cmd.includes("-snapshot")) return err("emulator exited 1: snapshot load failed");
		const avd = cmd[cmd.indexOf("-avd") + 1] ?? "";
		const port = cmd[cmd.indexOf("-port") + 1] ?? "";
		const pid = nextPid++;
		const writable = !cmd.includes("-read-only");
		if (!(writable && opts.buildDies)) running.set(`emulator-${port}`, { avd, pid, writable, command: cmd.join(" ") });
		return ok({ pid });
	};

	const pidAlive = (pid: number) => processes.has(pid) || [...running.values()].some((i) => i.pid === pid);
	const sigkill = (pid: number, signal: "SIGKILL") => {
		kills.push([pid, signal]);
		if (opts.unkillable) return;
		for (const [serial, i] of running) if (i.pid === pid) running.delete(serial);
	};
	return { exec, spawnDetached, pidAlive, kill: sigkill, running, processes, spawned, calls, kills, opts };
}

type Host = ReturnType<typeof fakeAndroidHost>;

/** A clock that only moves when something sleeps. */
function fakeClock(start = 1_000) {
	let t = start;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

function goldenDeps(host: Host, logs: string[] = [], over: Partial<AndroidGoldenDeps> = {}): AndroidGoldenDeps {
	return {
		exec: host.exec,
		store,
		owner,
		pid: process.pid,
		env: env(),
		now: () => 1_000,
		pidAlive: host.pidAlive,
		sleep: async () => {},
		log: (line) => logs.push(line),
		spawnDetached: host.spawnDetached,
		kill: host.kill,
		...over,
	};
}

/** The provider as the CLI wires it: claims only look the snapshot up (`snapshotForClaim`), never build it. */
function provider(
	host: Host,
	logs: string[] = [],
	hook?: (avd: string) => AsyncResult<string | undefined>,
	now: () => number = () => 1_000
) {
	const golden = goldenDeps(host, logs, { now });
	return createAndroidProvider(
		{ exec: host.exec, store, env: env(), now: () => 1_000, owner, log: (line) => logs.push(line) },
		{
			spawnDetached: host.spawnDetached,
			pidAlive: host.pidAlive,
			sleep: async () => {},
			snapshot: hook ?? ((avd) => snapshotForClaim(golden, avd)),
			snapshotFailed: (avd, name) => invalidateAndroidSnapshot(golden, avd, name),
			snapshotLoaded: (avd) => androidSnapshotLoaded(store, avd),
		}
	);
}

async function currentKey(host: Host): Promise<string> {
	const read = await readSnapshotInputs(goldenDeps(host), "Pixel_10");
	if (!read.success || read.data === undefined) throw new Error("no inputs");
	return androidSnapshotKey(read.data.inputs);
}

const INPUTS: AndroidSnapshotInputs = {
	imageRevision: "5",
	fingerprint: "google/sdk:16/BP22",
	emulatorVersion: "35.4.9",
	hardware: ["hw.cpu.ncore=4", "hw.ramSize=4096", `image.sysdir.1=${SYSDIR}`],
};

describe("snapshot key", () => {
	test("10 hex, stable, independent of hw line order", () => {
		const key = androidSnapshotKey(INPUTS);
		expect(key).toMatch(/^[0-9a-f]{10}$/);
		expect(androidSnapshotKey({ ...INPUTS, hardware: [...INPUTS.hardware].reverse() })).toBe(key);
	});

	test("every input and the recipe change it", () => {
		const key = androidSnapshotKey(INPUTS);
		expect(androidSnapshotKey({ ...INPUTS, imageRevision: "6" })).not.toBe(key);
		expect(androidSnapshotKey({ ...INPUTS, fingerprint: "other" })).not.toBe(key);
		expect(androidSnapshotKey({ ...INPUTS, emulatorVersion: "36.1.0" })).not.toBe(key);
		expect(androidSnapshotKey({ ...INPUTS, hardware: ["hw.ramSize=2048"] })).not.toBe(key);
		expect(androidSnapshotKey(INPUTS, 2)).not.toBe(key);
		expect(androidSnapshotKey({ ...INPUTS, flags: ["-no-metrics"] })).not.toBe(key);
	});

	test("read from the SDK and AVD files: image revision, fingerprint, emulator version, hw.* lines", async () => {
		const read = await readSnapshotInputs(goldenDeps(fakeAndroidHost()), "Pixel_10");
		expect(read).toEqual(
			ok({
				dir: join(avdHomeDir, "Pixel_10.avd"),
				inputs: {
					imageRevision: "5",
					fingerprint: "google/sdk_gphone64_arm64/emu64a:16/BP22/1:userdebug/dev-keys",
					emulatorVersion: "35.4.9",
					hardware: [
						"hw.cpu.ncore=4",
						"hw.ramSize=4096",
						"hw.lcd.density=420",
						`image.sysdir.1=${SYSDIR}`,
						"disk.dataPartition.size=6G",
					],
					flags: ["-no-audio", "-no-metrics"],
				},
			})
		);
	});

	test("no SDK root → no snapshot (not an error), said once per process (R8)", async () => {
		const logs: string[] = [];
		const deps = { ...goldenDeps(fakeAndroidHost(), logs), env: { ANDROID_AVD_HOME: avdHomeDir, WARDEN_HOME: dir } };
		expect(await readSnapshotInputs(deps, "Pixel_10")).toEqual(ok(undefined));
		expect(await ensureAndroidSnapshot(deps, "Pixel_10")).toEqual(ok(undefined));
		expect(await snapshotForClaim(deps, "Pixel_10")).toEqual(ok(undefined));
		expect(logs.filter((l) => l.includes("ANDROID_HOME"))).toHaveLength(1);
	});

	test("AVD home follows the emulator's precedence (R8)", () => {
		expect(avdHome({ ANDROID_AVD_HOME: "/a", ANDROID_EMULATOR_HOME: "/e", HOME: "/h" })).toBe("/a");
		expect(avdHome({ ANDROID_EMULATOR_HOME: "/e", ANDROID_SDK_HOME: "/s", HOME: "/h" })).toBe("/e/avd");
		expect(avdHome({ ANDROID_USER_HOME: "/u", ANDROID_SDK_HOME: "/s", HOME: "/h" })).toBe("/u/avd");
		expect(avdHome({ ANDROID_SDK_HOME: "/s", HOME: "/h" })).toBe("/s/.android/avd");
		expect(avdHome({ HOME: "/h" })).toBe("/h/.android/avd");
		expect(avdHome({})).not.toContain("~");
	});

	test("parsers", () => {
		expect(parseProperties("# c\na=1\n b = two \nbad\n")).toEqual(
			new Map([
				["a", "1"],
				["b", "two"],
			])
		);
		expect(parseEmulatorVersion("INFO | x\nAndroid emulator version 35.4.9.0 (build_id 13025442) (CL:N/A)\n")).toBe(
			"35.4.9.0"
		);
	});
});

describe("opt-out", () => {
	test("on by default; WARDEN_ANDROID_SNAPSHOT=0 or config false turns it off; =1 overrides the config", () => {
		expect(androidSnapshotEnabled({})).toBe(true);
		expect(androidSnapshotEnabled({ WARDEN_ANDROID_SNAPSHOT: "0" })).toBe(false);
		expect(androidSnapshotEnabled({}, false)).toBe(false);
		expect(androidSnapshotEnabled({ WARDEN_ANDROID_SNAPSHOT: "1" }, false)).toBe(true);
		expect(androidSnapshotEnabled({ WARDEN_ANDROID_SNAPSHOT: "0" }, true)).toBe(false);
	});

	test("only 0/1/true/false/on/off/yes/no count as explicit; anything else warns and defers to the config (R7)", () => {
		const warned: string[] = [];
		const warn = (v: string) => warned.push(v);
		expect(explicitAndroidSnapshot({ WARDEN_ANDROID_SNAPSHOT: "off" }, warn)).toBe(false);
		expect(explicitAndroidSnapshot({ WARDEN_ANDROID_SNAPSHOT: " YES " }, warn)).toBe(true);
		expect(explicitAndroidSnapshot({ WARDEN_ANDROID_SNAPSHOT: "" }, warn)).toBeUndefined();
		expect(explicitAndroidSnapshot({}, warn)).toBeUndefined();
		expect(warned).toEqual([]);
		expect(explicitAndroidSnapshot({ WARDEN_ANDROID_SNAPSHOT: "nah" }, warn)).toBeUndefined();
		expect(warned).toEqual(["nah"]);
		expect(androidSnapshotEnabled({ WARDEN_ANDROID_SNAPSHOT: "off" }, true)).toBe(false);
		expect(androidSnapshotEnabled({ WARDEN_ANDROID_SNAPSHOT: "nah" }, false)).toBe(false);
	});
});

async function claim(host: Host, logs: string[] = [], hook?: (avd: string) => AsyncResult<string | undefined>) {
	return claimDevices({
		store,
		provider: provider(host, logs, hook),
		owner,
		request: { platform: "android", profile: "pixel-10", count: 1, max: 4 },
		ttlMs: 60_000,
		now: () => 1_000,
		pidAlive: () => false,
		waitMs: 0,
		sleep: async () => {},
	});
}

/** Build what the first claim found missing, as `warden gc` does once the AVD is idle. */
async function gcBuild(host: Host, logs: string[] = [], over: Partial<AndroidGoldenDeps> = {}) {
	return buildPendingAndroidSnapshot(goldenDeps(host, logs, over));
}

describe("claims launch from warden's snapshot; the build runs outside any claim (R2)", () => {
	test("a claim with no snapshot cold-boots read-only at once, logs one line, and leaves the build to gc", async () => {
		const host = fakeAndroidHost();
		const logs: string[] = [];
		const result = await claim(host, logs);
		expect(result.success && result.data.claimed.map((c) => c.action)).toEqual(["create"]);
		expect(host.spawned).toHaveLength(1);
		expect(host.spawned[0]).toContain("-read-only");
		expect(host.spawned[0]).not.toContain("-snapshot");
		expect(host.calls.some((c) => c.includes("snapshot save"))).toBe(false);
		expect(logs.filter((l) => l.includes("no quick-boot snapshot"))).toHaveLength(1);
		expect(store.listLeases().some((l) => l.resource.kind === "build")).toBe(false);
		expect(pendingAndroidSnapshots(store, 1_000)).toEqual(["Pixel_10"]);
	});

	test("gc builds it once the AVD is idle; the next claim launches from it with no build", async () => {
		const host = fakeAndroidHost();
		expect((await claim(host)).success).toBe(true);
		// the claim's emulator still runs: gc leaves the AVD alone
		expect(await gcBuild(host)).toEqual(ok({ busy: ["Pixel_10"] }));
		expect(host.spawned).toHaveLength(1);
		host.running.clear();
		const pass = await gcBuild(host);
		const name = snapshotName(await currentKey(host));
		expect(pass.success && pass.data.built?.name).toBe(name);
		const build = host.spawned[1];
		expect(build).not.toContain("-read-only");
		expect(build).toEqual(
			expect.arrayContaining(["-no-snapshot-load", "-no-snapshot-save", "-no-audio", "-no-window"])
		);
		expect(existsSync(join(avdHomeDir, "Pixel_10.avd", "snapshots", name, "snapshot.pb"))).toBe(true);
		// only the first claim's own leases are left: no build lock, no golden port lease
		expect(store.listLeases().filter((l) => l.label?.startsWith(GOLDEN_PORT_LABEL))).toHaveLength(0);
		expect(store.listLeases().some((l) => l.resource.kind === "build")).toBe(false);
		expect(pendingAndroidSnapshots(store, 1_000)).toEqual([]);
		const saves = host.calls.filter((c) => c.includes("snapshot save")).length;
		expect((await claim(host)).success).toBe(true);
		expect(host.spawned.at(-1)).toEqual(expect.arrayContaining(["-read-only", "-snapshot", name, "-no-snapshot-save"]));
		expect(host.calls.filter((c) => c.includes("snapshot save")).length).toBe(saves);
	});

	test("gc builds at most one AVD per pass", async () => {
		const host = fakeAndroidHost({ avds: ["Pixel_10", "Pixel_9"] });
		writeAvd("Pixel_9");
		markAndroidSnapshotPending(store, "Pixel_10");
		markAndroidSnapshotPending(store, "Pixel_9");
		const pass = await gcBuild(host);
		expect(pass.success && pass.data.built?.avd).toBe("Pixel_10");
		expect(host.spawned).toHaveLength(1);
		expect(pendingAndroidSnapshots(store, 1_000)).toEqual(["Pixel_9"]);
	});

	test("a failed gc build is not retried for a while", async () => {
		const host = fakeAndroidHost({ buildDies: true });
		markAndroidSnapshotPending(store, "Pixel_10");
		const pass = await gcBuild(host);
		expect(pass.success && pass.data.failed?.avd).toBe("Pixel_10");
		expect(pendingAndroidSnapshots(store, 1_000)).toEqual([]);
		expect(pendingAndroidSnapshots(store, 1_000 + 7 * 60 * 60_000)).toEqual(["Pixel_10"]);
	});

	test("a launch from the snapshot that fails falls back to a cold boot, logged", async () => {
		const host = fakeAndroidHost({ snapshotLaunchFails: true });
		expect((await ensureAndroidSnapshot(goldenDeps(host), "Pixel_10")).success).toBe(true);
		const logs: string[] = [];
		const result = await claim(host, logs);
		expect(result.success).toBe(true);
		const last = host.spawned.at(-1);
		expect(last).toContain("-read-only");
		expect(last).not.toContain("-snapshot");
		expect(logs.join("\n")).toContain("retrying with a cold boot");
	});

	test("the hook erroring: the claim cold-boots with today's argv (R9)", async () => {
		const host = fakeAndroidHost();
		const logs: string[] = [];
		const result = await claim(host, logs, async () => err("config.ini unreadable"));
		expect(result.success).toBe(true);
		expect(host.spawned).toHaveLength(1);
		expect(host.spawned[0]).toContain("-read-only");
		expect(host.spawned[0]).not.toContain("-snapshot");
		expect(logs.join("\n")).toContain("config.ini unreadable");
	});

	test("opted out (no snapshot hook): never builds", async () => {
		const host = fakeAndroidHost();
		const plain = createAndroidProvider(
			{ exec: host.exec, store, env: env(), now: () => 1_000, owner },
			{ spawnDetached: host.spawnDetached, pidAlive: host.pidAlive, sleep: async () => {} }
		);
		expect((await plain.create("w", "pixel-10")).success).toBe(true);
		expect(host.spawned).toHaveLength(1);
		expect(host.spawned[0]).not.toContain("-snapshot");
		expect(host.calls.some((c) => c.includes("snapshot save"))).toBe(false);
	});

	test("a busy AVD (an instance already running) is skipped: no writable build", async () => {
		const host = fakeAndroidHost();
		host.running.set("emulator-5580", { avd: "Pixel_10", pid: 99, writable: false });
		const logs: string[] = [];
		const ensured = await ensureAndroidSnapshot(goldenDeps(host, logs), "Pixel_10");
		expect(ensured).toEqual(ok(undefined));
		expect(host.spawned).toHaveLength(0);
		expect(logs.join("\n")).toContain("is running");
	});

	test("another AVD running does not make this one busy", async () => {
		const host = fakeAndroidHost({ avds: ["Pixel_10", "Pixel_9"] });
		host.running.set("emulator-5580", { avd: "Pixel_9", pid: 99, writable: false });
		const ensured = await ensureAndroidSnapshot(goldenDeps(host), "Pixel_10");
		expect(ensured.success && ensured.data?.built).toBe(true);
	});

	test("a failed save leaves no snapshot and kills the build instance", async () => {
		const host = fakeAndroidHost();
		const base = host.exec;
		const exec: Exec = async (cmd, opts) =>
			cmd.join(" ").includes("snapshot save") ? out("KO: not enough disk space\r\n") : base(cmd, opts);
		const ensured = await ensureAndroidSnapshot({ ...goldenDeps(host), exec }, "Pixel_10");
		expect(ensured.success).toBe(false);
		if (!ensured.success) expect(ensured.error).toContain("not enough disk space");
		expect(host.running.size).toBe(0);
		expect(store.listLeases()).toHaveLength(0);
	});
});

describe("build failure paths and concurrency (R3, R9)", () => {
	test("a second process waiting on the lock takes the fast path once the holder is done", async () => {
		const host = fakeAndroidHost();
		const key = await currentKey(host);
		const held = store.insertLease(
			{ resource: { kind: "build", key: "golden:android:Pixel_10" }, owner, ttlMs: 60_000, pid: 4242, label: "build" },
			1_000
		);
		const logs: string[] = [];
		let polls = 0;
		const ensured = await ensureAndroidSnapshot(
			goldenDeps(host, logs, {
				sleep: async () => {
					if (++polls > 1) return;
					// the holder finishes its build
					const snap = join(avdHomeDir, "Pixel_10.avd", "snapshots", snapshotName(key));
					mkdirSync(snap, { recursive: true });
					writeFileSync(join(snap, "snapshot.pb"), "pb");
					store.deleteLeases([held.id]);
				},
			}),
			"Pixel_10"
		);
		expect(ensured).toEqual(ok({ avd: "Pixel_10", name: snapshotName(key), key, built: false }));
		expect(polls).toBe(1);
		expect(host.spawned).toHaveLength(0);
		expect(logs.join("\n")).toContain("waiting");
		expect(store.listLeases()).toHaveLength(0);
	});

	test("the build instance dying while booting: err, lock and port lease released", async () => {
		const host = fakeAndroidHost({ buildDies: true });
		const ensured = await ensureAndroidSnapshot(goldenDeps(host), "Pixel_10");
		expect(ensured.success).toBe(false);
		expect(store.listLeases()).toHaveLength(0);
		expect(existsSync(join(avdHomeDir, "Pixel_10.avd", "snapshots"))).toBe(false);
	});

	test("the build instance never booting: times out, is killed, lock and port lease released", async () => {
		const host = fakeAndroidHost({ buildNeverBoots: true });
		const clock = fakeClock();
		const ensured = await ensureAndroidSnapshot(
			goldenDeps(host, [], { ...clock, timing: { bootTimeoutMs: 5_000 } }),
			"Pixel_10"
		);
		expect(ensured.success).toBe(false);
		if (!ensured.success) expect(ensured.error).toContain("timed out");
		expect(host.running.size).toBe(0);
		expect(store.listLeases()).toHaveLength(0);
	});

	test("emu kill not ending the build instance: SIGKILL after the exit timeout", async () => {
		const host = fakeAndroidHost({ killIgnored: true });
		const clock = fakeClock();
		const logs: string[] = [];
		const ensured = await ensureAndroidSnapshot(
			goldenDeps(host, logs, { ...clock, timing: { exitTimeoutMs: 2_000 } }),
			"Pixel_10"
		);
		expect(ensured.success && ensured.data?.built).toBe(true);
		expect(host.kills).toEqual([[100, "SIGKILL"]]);
		expect(host.running.size).toBe(0);
		expect(store.listLeases()).toHaveLength(0);
	});

	test("an instance that survives SIGKILL keeps its pid-backed port lease, and the next build reaps it", async () => {
		const host = fakeAndroidHost({ killIgnored: true, unkillable: true });
		const clock = fakeClock();
		const deps = goldenDeps(host, [], { ...clock, timing: { exitTimeoutMs: 2_000 } });
		const ensured = await ensureAndroidSnapshot(deps, "Pixel_10");
		expect(ensured.success).toBe(false);
		const leftover = store.listLeases();
		expect(leftover.map((l) => [l.label, l.pid])).toEqual([[`${GOLDEN_PORT_LABEL}Pixel_10`, 100]]);
		// the instance finally goes; a later build cleans up and builds
		host.running.clear();
		host.opts.killIgnored = false;
		host.opts.unkillable = false;
		const again = await ensureAndroidSnapshot(goldenDeps(host, [], clock), "Pixel_10");
		expect(again.success && again.data?.built).toBe(true);
		expect(store.listLeases()).toHaveLength(0);
	});

	test("an orphaned build emulator (its warden died) is killed before the AVD counts as busy", async () => {
		const host = fakeAndroidHost();
		host.running.set("emulator-5580", {
			avd: "Pixel_10",
			pid: 77,
			writable: true,
			command: `${EMULATOR()} -avd Pixel_10 -port 5580 -no-window -no-snapshot-load`,
		});
		store.insertLease(
			{ resource: { kind: "port", port: 5580 }, owner, ttlMs: 60_000, pid: 77, label: `${GOLDEN_PORT_LABEL}Pixel_10` },
			1_000
		);
		const logs: string[] = [];
		const ensured = await ensureAndroidSnapshot(goldenDeps(host, logs), "Pixel_10");
		expect(ensured.success && ensured.data?.built).toBe(true);
		expect(host.calls).toContain(`${ADB()} -s emulator-5580 emu kill`);
		expect(logs.join("\n")).toContain("leftover");
		expect(store.listLeases()).toHaveLength(0);
	});

	function goldenLease(port: number, pid?: number) {
		return store.insertLease(
			{ resource: { kind: "port", port }, owner, ttlMs: 60_000, pid, label: `${GOLDEN_PORT_LABEL}Pixel_10` },
			1_000
		);
	}
	const studio = { avd: "Pixel_10", pid: 300, writable: true };

	test("a golden lease whose pid is dead: the user's emulator now on its port is left alone, the AVD is busy (S1)", async () => {
		const host = fakeAndroidHost();
		goldenLease(5554, 77);
		host.running.set("emulator-5554", studio);
		markAndroidSnapshotPending(store, "Pixel_10");
		const logs: string[] = [];
		const pass = await gcBuild(host, logs);
		expect(pass).toEqual(ok({ busy: ["Pixel_10"] }));
		expect(host.calls.filter((c) => c.endsWith("emu kill"))).toEqual([]);
		expect(host.kills).toEqual([]);
		expect(host.running.has("emulator-5554")).toBe(true);
		expect(host.spawned).toHaveLength(0);
		expect(store.listLeases()).toHaveLength(0);
		expect(logs.join("\n")).toContain("is running (emulator-5554)");
	});

	test("a golden lease with no pid: the instance on its port is not stopped (S1)", async () => {
		const host = fakeAndroidHost();
		goldenLease(5554);
		host.running.set("emulator-5554", studio);
		expect(await ensureAndroidSnapshot(goldenDeps(host), "Pixel_10")).toEqual(ok(undefined));
		expect(host.calls.filter((c) => c.endsWith("emu kill"))).toEqual([]);
		expect(store.listLeases()).toHaveLength(0);
	});

	test("a golden lease whose pid was reused by another process: nothing is stopped or signalled (S1)", async () => {
		const host = fakeAndroidHost();
		goldenLease(5554, 77);
		host.processes.set(77, "/usr/bin/python3 -m http.server");
		host.running.set("emulator-5554", studio);
		const clock = fakeClock();
		expect(await ensureAndroidSnapshot(goldenDeps(host, [], clock), "Pixel_10")).toEqual(ok(undefined));
		expect(host.calls.filter((c) => c.endsWith("emu kill"))).toEqual([]);
		expect(host.kills).toEqual([]);
		expect(host.processes.has(77)).toBe(true);
		expect(host.running.has("emulator-5554")).toBe(true);
		expect(store.listLeases()).toHaveLength(0);
	});

	test("a live build emulator adb does not name keeps its lease, and no second build starts beside it (S3)", async () => {
		const host = fakeAndroidHost();
		goldenLease(5580, 77);
		host.processes.set(77, `${EMULATOR()} -avd Pixel_10 -port 5580 -no-window -no-snapshot-load -no-snapshot-save`);
		markAndroidSnapshotPending(store, "Pixel_10");
		const logs: string[] = [];
		const pass = await gcBuild(host, logs);
		expect(pass).toEqual(ok({ busy: ["Pixel_10"] }));
		expect(host.spawned).toHaveLength(0);
		expect(host.kills).toEqual([]);
		expect(store.listLeases().map((l) => l.pid)).toEqual([77]);
		expect(logs.join("\n")).toContain("is running (emulator-5580)");
	});

	test("the build records its emulator pid on the golden port lease, and inventory marks it golden mid-build", async () => {
		const host = fakeAndroidHost();
		const seen: Array<{ pid?: number; golden?: boolean }> = [];
		const inventory = createAndroidProvider({ exec: host.exec, store, env: env(), now: () => 1_000, owner });
		let looked = false;
		const ensured = await ensureAndroidSnapshot(
			goldenDeps(host, [], {
				sleep: async () => {
					if (looked) return;
					looked = true;
					const lease = store.listLeases().find((l) => l.label?.startsWith(GOLDEN_PORT_LABEL));
					const listed = await inventory.inventory();
					seen.push({ pid: lease?.pid, golden: listed.success ? listed.data[0]?.golden : undefined });
				},
			}),
			"Pixel_10"
		);
		expect(ensured.success && ensured.data?.built).toBe(true);
		expect(seen).toEqual([{ pid: 100, golden: true }]);
	});
});

describe("a snapshot that does not load (R5)", () => {
	test("the claim that saw it fail deletes it under the lock and marks the AVD for a rebuild", async () => {
		const host = fakeAndroidHost();
		const built = await ensureAndroidSnapshot(goldenDeps(host), "Pixel_10");
		if (!built.success || built.data === undefined) throw new Error("no build");
		const p = provider(host);
		const created = await p.create("w", "pixel-10");
		if (!created.success) throw new Error(created.error);
		writeFileSync(
			join(dir, "logs", `${created.data.id}.log`),
			`INFO    | Loading snapshot '${built.data.name}'...\nWARNING | Failed to load snapshot '${built.data.name}'\n`,
			{ flag: "a" }
		);
		expect((await p.waitReady(created.data.id, 10_000)).success).toBe(true);
		expect(existsSync(join(avdHomeDir, "Pixel_10.avd", "snapshots", built.data.name))).toBe(false);
		expect(pendingAndroidSnapshots(store, 1_000)).toEqual(["Pixel_10"]);
		expect(store.listLeases().some((l) => l.resource.kind === "build")).toBe(false);
	});

	/** A claim launched from the current snapshot whose log says it did not load (or did, with `loads`). */
	async function claimSeeing(host: Host, at: number, logs: string[] = [], loads = false) {
		const p = provider(host, logs, undefined, () => at);
		const created = await p.create("w", "pixel-10");
		if (!created.success) throw new Error(created.error);
		const name = snapshotName(await currentKey(host));
		const line = loads ? `Successfully loaded snapshot '${name}'` : `WARNING | Failed to load snapshot '${name}'`;
		writeFileSync(join(dir, "logs", `${created.data.id}.log`), `${line}\n`, { flag: "a" });
		expect((await p.waitReady(created.data.id, 10_000)).success).toBe(true);
		host.running.clear();
		store.deleteLeases(store.listLeases().map((l) => l.id));
	}

	test("a snapshot that keeps failing to load backs off, then gc stops rebuilding it; golden ensure resets (S2)", async () => {
		const host = fakeAndroidHost();
		const logs: string[] = [];
		const t0 = 10_000;
		expect((await ensureAndroidSnapshot(goldenDeps(host, [], { now: () => t0 }), "Pixel_10")).success).toBe(true);
		// first failure: rebuilt at the next pass, as before
		await claimSeeing(host, t0, logs);
		expect(androidSnapshotsDue(store, {}, t0)).toBe(true);
		expect((await gcBuild(host, [], { now: () => t0 })).success).toBe(true);
		expect(pendingAndroidSnapshots(store, t0)).toEqual([]);
		// second, within the retry window: the rebuild waits it out, one line says why
		const t1 = t0 + 60_000;
		await claimSeeing(host, t1, logs);
		expect(logs.filter((l) => l.includes("does not load on this host"))).toHaveLength(1);
		expect(androidSnapshotsDue(store, {}, t1 + 10 * 60_000)).toBe(false);
		const t2 = t1 + ANDROID_SNAPSHOT_RETRY_MS;
		expect(pendingAndroidSnapshots(store, t2)).toEqual(["Pixel_10"]);
		expect((await gcBuild(host, [], { now: () => t2 })).success).toBe(true);
		// third: gc gives up on it
		await claimSeeing(host, t2 + 60_000, logs);
		const later = t2 + 10 * ANDROID_SNAPSHOT_RETRY_MS;
		expect(pendingAndroidSnapshots(store, later)).toEqual([]);
		expect(androidSnapshotsDue(store, {}, later)).toBe(false);
		expect(androidSnapshotsGivenUp(store)).toEqual(["Pixel_10"]);
		const spawned = host.spawned.length;
		expect(await gcBuild(host, [], { now: () => later })).toEqual(ok({ busy: [] }));
		expect(host.spawned).toHaveLength(spawned);
		// `warden golden ensure` builds it and starts the count over
		const ensured = await ensureAndroidSnapshot(goldenDeps(host, [], { now: () => later }), "Pixel_10", {
			explicit: true,
		});
		expect(ensured.success && ensured.data?.built).toBe(true);
		expect(androidSnapshotsGivenUp(store)).toEqual([]);
		await claimSeeing(host, later, logs);
		expect(androidSnapshotsDue(store, {}, later)).toBe(true);
	});

	test("a claim that loads the snapshot starts the load-failure count over (S2)", async () => {
		const host = fakeAndroidHost();
		const t0 = 10_000;
		expect((await ensureAndroidSnapshot(goldenDeps(host, [], { now: () => t0 }), "Pixel_10")).success).toBe(true);
		await claimSeeing(host, t0);
		expect((await gcBuild(host, [], { now: () => t0 })).success).toBe(true);
		await claimSeeing(host, t0 + 1_000, [], true);
		// a failure right after a good load is a first failure again: due at once
		await claimSeeing(host, t0 + 2_000);
		expect(androidSnapshotsDue(store, {}, t0 + 2_000)).toBe(true);
	});

	test("a gc pass that finds the AVD busy keeps auto-gc from spawning for it for a while (S5)", async () => {
		const host = fakeAndroidHost();
		markAndroidSnapshotPending(store, "Pixel_10");
		host.running.set("emulator-5580", { avd: "Pixel_10", pid: 99, writable: false });
		expect(androidSnapshotsDue(store, {}, 1_000)).toBe(true);
		expect(await gcBuild(host)).toEqual(ok({ busy: ["Pixel_10"] }));
		expect(androidSnapshotsDue(store, {}, 1_000 + 30 * 60_000)).toBe(false);
		expect(pendingAndroidSnapshots(store, 1_000 + 30 * 60_000)).toEqual(["Pixel_10"]);
		expect(androidSnapshotsDue(store, {}, 1_000 + 60 * 60_000)).toBe(true);
	});

	test("a failure line an earlier run left in the same log is not this launch's", async () => {
		const host = fakeAndroidHost();
		const built = await ensureAndroidSnapshot(goldenDeps(host), "Pixel_10");
		if (!built.success || built.data === undefined) throw new Error("no build");
		mkdirSync(join(dir, "logs"), { recursive: true });
		writeFileSync(join(dir, "logs", "emulator-5554.log"), `WARNING | Failed to load snapshot '${built.data.name}'\n`);
		const p = provider(host);
		const created = await p.create("w", "pixel-10");
		if (!created.success) throw new Error(created.error);
		expect(created.data.id).toBe("emulator-5554");
		expect((await p.waitReady(created.data.id, 10_000)).success).toBe(true);
		expect(existsSync(join(avdHomeDir, "Pixel_10.avd", "snapshots", built.data.name))).toBe(true);
	});

	test("the key covers the launch flags and the non-hw config that shapes the guest", async () => {
		const host = fakeAndroidHost();
		const base = await currentKey(host);
		const audio = await readSnapshotInputs(
			{ ...goldenDeps(host), env: { ...env(), WARDEN_EMULATOR_AUDIO: "1" } },
			"Pixel_10"
		);
		expect(audio.success && audio.data && androidSnapshotKey(audio.data.inputs)).not.toBe(base);
		writeAvd("Pixel_10", CONFIG_INI.replace("disk.dataPartition.size=6G", "disk.dataPartition.size=8G"));
		expect(await currentKey(host)).not.toBe(base);
		writeAvd("Pixel_10", `${CONFIG_INI}fastboot.forceColdBoot=yes\navd.ini.displayname=Pixel 10\n`);
		expect(await currentKey(host)).toBe(base);
	});
});

describe("stale snapshots", () => {
	function plant(name: string): string {
		const snap = join(avdHomeDir, "Pixel_10.avd", "snapshots", name);
		mkdirSync(snap, { recursive: true });
		writeFileSync(join(snap, "snapshot.pb"), "pb");
		return snap;
	}

	test("a key change makes the old snapshot stale: list marks it, prune deletes it, default_boot untouched", async () => {
		const host = fakeAndroidHost();
		const current = snapshotName(await currentKey(host));
		const stale = plant("warden-0000000000");
		const mine = plant(current);
		const userBoot = plant("default_boot");
		const listed = await listAndroidSnapshots(goldenDeps(host));
		expect(listed.success && listed.data.map((e) => [e.name, e.current])).toEqual(
			[
				["warden-0000000000", false],
				[current, true],
			].sort()
		);
		const pruned = await pruneAndroidSnapshots(goldenDeps(host), { all: false });
		expect(pruned.success && pruned.data.map((e) => e.name)).toEqual(["warden-0000000000"]);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(mine)).toBe(true);
		expect(existsSync(userBoot)).toBe(true);
	});

	test("prune --all deletes the current one too; a running AVD keeps its snapshots", async () => {
		const host = fakeAndroidHost();
		const current = plant(snapshotName(await currentKey(host)));
		host.running.set("emulator-5580", { avd: "Pixel_10", pid: 99, writable: false });
		const kept = await pruneAndroidSnapshots(goldenDeps(host), { all: true });
		expect(kept).toEqual(ok([]));
		expect(existsSync(current)).toBe(true);
		host.running.clear();
		const pruned = await pruneAndroidSnapshots(goldenDeps(host), { all: true });
		expect(pruned.success && pruned.data).toHaveLength(1);
		expect(existsSync(current)).toBe(false);
	});

	test("building a new key deletes this AVD's stale warden snapshots", async () => {
		const host = fakeAndroidHost();
		const stale = plant("warden-0000000000");
		const ensured = await ensureAndroidSnapshot(goldenDeps(host), "Pixel_10");
		expect(ensured.success && ensured.data?.built).toBe(true);
		expect(existsSync(stale)).toBe(false);
	});
});
