import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import { claimDevices } from "../claim";
import type { Exec, ExecResult } from "../exec";
import { BOOT_WAIT_SCRIPT, createAndroidProvider, type SpawnDetached } from "../providers/android";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import {
	type AndroidGoldenDeps,
	type AndroidSnapshotInputs,
	androidSnapshotEnabled,
	androidSnapshotKey,
	ensureAndroidSnapshot,
	listAndroidSnapshots,
	parseEmulatorVersion,
	parseProperties,
	pruneAndroidSnapshots,
	readSnapshotInputs,
	snapshotName,
} from "./android-golden";

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

type Instance = { avd: string; pid: number; writable: boolean };

/**
 * Stateful fake adb + emulator: a spawned emulator is listed by `adb devices` at once, boots at once,
 * `emu avd snapshot save` writes the snapshot dir (like the real console, into the AVD's `snapshots/`),
 * `emu kill` ends the process.
 */
function fakeAndroidHost(opts: { avds?: string[]; snapshotLaunchFails?: boolean } = {}) {
	const running = new Map<string, Instance>();
	const spawned: Array<readonly string[]> = [];
	const calls: string[] = [];
	let nextPid = 100;
	const avds = opts.avds ?? ["Pixel_10"];

	const exec: Exec = async (cmd) => {
		const key = cmd.join(" ");
		calls.push(key);
		if (key === `${EMULATOR()} -list-avds`) return out(`${avds.join("\n")}\n`);
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

	function deviceCommand(serial: string, instance: Instance, rest: string): ExecResult | undefined {
		if (rest === "emu avd name") return out(`${instance.avd}\r\nOK\r\n`);
		if (rest === `wait-for-device shell ${BOOT_WAIT_SCRIPT}`) return out("");
		if (rest === "shell getprop ro.build.version.sdk") return out("36\n");
		const save = /^emu avd snapshot save (\S+)$/.exec(rest)?.[1];
		if (save !== undefined) {
			if (!instance.writable) return out("KO: snapshot save is not allowed for read-only instances\r\n");
			const snap = join(avdHomeDir, `${instance.avd}.avd`, "snapshots", save);
			mkdirSync(snap, { recursive: true });
			writeFileSync(join(snap, "snapshot.pb"), "pb");
			return out("OK\r\n");
		}
		if (rest === "emu kill") {
			running.delete(serial);
			return out("OK: killing emulator, bye bye\r\n");
		}
		return undefined;
	}

	const spawnDetached: SpawnDetached = async (cmd) => {
		spawned.push(cmd);
		if (opts.snapshotLaunchFails && cmd.includes("-snapshot")) return err("emulator exited 1: snapshot load failed");
		const avd = cmd[cmd.indexOf("-avd") + 1] ?? "";
		const port = cmd[cmd.indexOf("-port") + 1] ?? "";
		const pid = nextPid++;
		running.set(`emulator-${port}`, { avd, pid, writable: !cmd.includes("-read-only") });
		return ok({ pid });
	};

	const pidAlive = (pid: number) => [...running.values()].some((i) => i.pid === pid);
	return { exec, spawnDetached, pidAlive, running, spawned, calls };
}

type Host = ReturnType<typeof fakeAndroidHost>;

function goldenDeps(host: Host, logs: string[] = []): AndroidGoldenDeps {
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
	};
}

function provider(host: Host, logs: string[] = []) {
	const golden = goldenDeps(host, logs);
	return createAndroidProvider(
		{ exec: host.exec, store, env: env(), now: () => 1_000, owner, log: (line) => logs.push(line) },
		{
			spawnDetached: host.spawnDetached,
			pidAlive: host.pidAlive,
			sleep: async () => {},
			snapshot: async (avd) => {
				const ensured = await ensureAndroidSnapshot(golden, avd);
				return ensured.success ? ok(ensured.data?.name) : ensured;
			},
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
					hardware: ["hw.cpu.ncore=4", "hw.ramSize=4096", "hw.lcd.density=420", `image.sysdir.1=${SYSDIR}`],
				},
			})
		);
	});

	test("no SDK root → no snapshot (not an error)", async () => {
		const deps = { ...goldenDeps(fakeAndroidHost()), env: { ANDROID_AVD_HOME: avdHomeDir, WARDEN_HOME: dir } };
		expect(await readSnapshotInputs(deps, "Pixel_10")).toEqual(ok(undefined));
		expect(await ensureAndroidSnapshot(deps, "Pixel_10")).toEqual(ok(undefined));
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
});

async function claim(host: Host, logs: string[] = []) {
	return claimDevices({
		store,
		provider: provider(host, logs),
		owner,
		request: { platform: "android", profile: "pixel-10", count: 1, max: 4 },
		ttlMs: 60_000,
		now: () => 1_000,
		pidAlive: () => false,
		waitMs: 0,
		sleep: async () => {},
	});
}

describe("claims launch from warden's snapshot", () => {
	test("the first claim builds the snapshot from a writable cold boot, then launches from it", async () => {
		const host = fakeAndroidHost();
		const logs: string[] = [];
		const result = await claim(host, logs);
		expect(result.success && result.data.claimed.map((c) => c.action)).toEqual(["create"]);
		const name = snapshotName(await currentKey(host));
		expect(host.spawned).toHaveLength(2);
		const [build, launch] = host.spawned;
		expect(build).not.toContain("-read-only");
		expect(build).toEqual(
			expect.arrayContaining(["-no-snapshot-load", "-no-snapshot-save", "-no-audio", "-no-window"])
		);
		expect(launch).toEqual(expect.arrayContaining(["-read-only", "-snapshot", name, "-no-snapshot-save"]));
		expect(host.calls.some((c) => c.endsWith(`emu avd snapshot save ${name}`))).toBe(true);
		expect(existsSync(join(avdHomeDir, "Pixel_10.avd", "snapshots", name, "snapshot.pb"))).toBe(true);
		// the build instance is gone and its port lease released; the claim's emulator keeps its own
		expect([...host.running.values()].map((i) => i.writable)).toEqual([false]);
		expect(store.listLeases().filter((l) => l.label?.startsWith("emulator golden"))).toHaveLength(0);
		expect(store.listLeases().some((l) => l.resource.kind === "build")).toBe(false);
		expect(logs.join("\n")).toContain("building");
	});

	test("the second claim launches from it directly: no build", async () => {
		const host = fakeAndroidHost();
		expect((await claim(host)).success).toBe(true);
		const spawnedBefore = host.spawned.length;
		const saves = () => host.calls.filter((c) => c.includes("snapshot save")).length;
		const savesBefore = saves();
		expect((await claim(host)).success).toBe(true);
		expect(host.spawned.length).toBe(spawnedBefore + 1);
		expect(host.spawned.at(-1)).toContain("-snapshot");
		expect(saves()).toBe(savesBefore);
	});

	test("a launch from the snapshot that fails falls back to a cold boot, logged", async () => {
		const host = fakeAndroidHost({ snapshotLaunchFails: true });
		const logs: string[] = [];
		const result = await claim(host, logs);
		expect(result.success).toBe(true);
		const last = host.spawned.at(-1);
		expect(last).toContain("-read-only");
		expect(last).not.toContain("-snapshot");
		expect(logs.join("\n")).toContain("retrying with a cold boot");
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

	test("a busy AVD (an instance already running) is skipped: no writable build, cold boot", async () => {
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
