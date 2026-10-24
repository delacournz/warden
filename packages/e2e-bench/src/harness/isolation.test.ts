import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchAdapter } from "../adapters/adapter.types";
import { type FakeExec, type FakeRule, fakeExec } from "./exec";
import {
	ANIMATION_SETTINGS,
	type AnimationBaselines,
	isolate,
	KNOWN_PROCESS_PATTERNS,
	readAnimationScales,
	recordAnimationScales,
	restoreAnimationScales,
} from "./isolation";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const stub = (id: BenchAdapter["id"], residuePatterns: BenchAdapter["residuePatterns"]): BenchAdapter => ({
	id,
	supports: ["ios", "android"],
	doctor: async () => ({ ok: true, version: "1", notes: [] }),
	prepare: async () => ({ success: true, data: undefined }),
	run: async () => {
		throw new Error("unused");
	},
	teardown: async () => ({ success: true, data: undefined }),
	residuePatterns,
});

const next = stub("agent-device", {
	processes: [],
	driverBundleIds: ["com.example.driver-ios*"],
	dirs: [],
	stateDirs: ["~/.agent-device-bench/agent-device"],
});
const previous = stub("argent", { processes: [/oldframework/], driverBundleIds: [], dirs: [] });

/** The device's global settings; a missing key is what `settings get` prints as `null`. */
type Settings = Map<string, string>;

const allScales = (value: string): Settings => new Map(ANIMATION_SETTINGS.map((key) => [key, value]));

/** `adb shell settings get|put|delete global <key>` over an in-memory settings table. */
function settingsRules(settings: Settings): FakeRule[] {
	const isSettings = (verb: string) => (a: readonly string[]) =>
		a[3] === "settings" && a[4] === verb && a[5] === "global";
	return [
		{
			cmd: "adb",
			match: isSettings("get"),
			result: (a) => ({ stdout: `${settings.get(a[6] ?? "") ?? "null"}\n` }),
		},
		{
			cmd: "adb",
			match: isSettings("put"),
			result: (a) => {
				settings.set(a[6] ?? "", a[7] ?? "");
				return {};
			},
		},
		{
			cmd: "adb",
			match: isSettings("delete"),
			result: (a) => {
				settings.delete(a[6] ?? "");
				return { stdout: "Deleted 1 rows\n" };
			},
		},
	];
}

function make(extra: { adbBoot?: boolean; settings?: Settings } = {}): FakeExec {
	let polls = 0;
	return fakeExec(
		[
			...settingsRules(extra.settings ?? allScales("1.0")),
			{ cmd: "ps", result: { stdout: `${fx("ps.txt")}  900     1   100   0.0 /bin/oldframework run\n` } },
			{ cmd: "kill", result: {} },
			{ cmd: "xcrun", match: (a) => a[1] === "listapps", result: { stdout: fx("simctl-listapps.txt") } },
			{ cmd: "xcrun", result: {} },
			{ cmd: "bun", result: {} },
			{ cmd: "argent", result: {} },
			{ cmd: "agent-device", result: {} },
			{
				cmd: "adb",
				match: (a) => a.includes("getprop"),
				result: () => ({ stdout: ++polls >= 2 || !extra.adbBoot ? "1\n" : "0\n" }),
			},
			{
				cmd: "adb",
				match: (a) => a.includes("packages"),
				result: { stdout: "package:com.example.driver-ios\npackage:other\n" },
			},
			{ cmd: "adb", result: {} },
		],
		{ which: ["argent", "agent-device"] }
	);
}

const base = (exec: FakeExec) => ({
	exec,
	animationBaselines: new Map() as AnimationBaselines,
	platform: "ios" as const,
	udid: "AAAA-BBBB",
	benchPids: () => [100, 300, 900],
	ownedPaths: ["/Users/x/.agent-device-bench"],
	home: "/h",
	bundleId: "nz.co.delacour.warden.example",
	previous,
	next,
	log: () => undefined,
	repoRoot: "/repo",
	cliPath: "/repo/apps/cli/src/cli.ts",
	sleep: async () => undefined,
	cold: false,
	rebootBetween: false,
});

const cmds = (exec: FakeExec) =>
	exec.calls
		.filter((c) => c.cmd !== "ps" && !(c.cmd === "xcrun" && c.args[1] === "listapps"))
		.map((c) => [c.cmd, ...c.args].join(" "));

describe("isolate", () => {
	test("known patterns cover every framework helper", () => {
		expect(KNOWN_PROCESS_PATTERNS.some((p) => p.test("/x/warden-simd --udid U"))).toBe(true);
		expect(KNOWN_PROCESS_PATTERNS.some((p) => p.test("node /x/agent-device/dist/daemon.js"))).toBe(true);
	});

	test("ios warm: kill, stop helpers, terminate app only", async () => {
		const exec = make();
		const r = await isolate(base(exec));
		expect(cmds(exec)).toEqual([
			"kill -TERM 102 600 900",
			"kill -KILL 102 600 900",
			"bun /repo/apps/cli/src/cli.ts ui close --udid AAAA-BBBB",
			"agent-device daemon stop --state-dir /h/.agent-device-bench/agent-device --clean",
			"xcrun simctl terminate AAAA-BBBB nz.co.delacour.warden.example",
		]);
		expect(r).toEqual({
			success: true,
			data: { killed: expect.any(Array), uninstalled: [], rebooted: false },
		});
	});

	test("never kills or stops anything foreign", async () => {
		const exec = make();
		await isolate(base(exec));
		const killArgs = exec.calls.filter((c) => c.cmd === "kill").flatMap((c) => c.args);
		for (const foreign of ["500", "501", "502", "503"]) expect(killArgs).not.toContain(foreign);
		expect(cmds(exec).some((c) => c.startsWith("argent") || c === "agent-device daemon stop --clean")).toBe(false);
	});

	test("ios cold + reboot: uninstalls next's drivers, reboots, then terminates", async () => {
		const exec = make();
		const r = await isolate({ ...base(exec), cold: true, rebootBetween: true });
		expect(cmds(exec).slice(4)).toEqual([
			"xcrun simctl uninstall AAAA-BBBB com.example.driver-iosUITests.xctrunner",
			"xcrun simctl shutdown AAAA-BBBB",
			"xcrun simctl boot AAAA-BBBB",
			"xcrun simctl bootstatus AAAA-BBBB -b",
			"xcrun simctl terminate AAAA-BBBB nz.co.delacour.warden.example",
		]);
		expect(r.success && r.data).toMatchObject({
			uninstalled: ["com.example.driver-iosUITests.xctrunner"],
			rebooted: true,
		});
	});

	test("android cold + reboot polls boot_completed", async () => {
		const exec = make({ adbBoot: true });
		const r = await isolate({ ...base(exec), platform: "android", udid: "emu-1", cold: true, rebootBetween: true });
		const list = cmds(exec);
		expect(list).toContain("adb -s emu-1 uninstall com.example.driver-ios");
		expect(list.slice(list.indexOf("adb -s emu-1 reboot"))).toEqual([
			"adb -s emu-1 reboot",
			"adb -s emu-1 wait-for-device",
			"adb -s emu-1 shell getprop sys.boot_completed",
			"adb -s emu-1 shell getprop sys.boot_completed",
			"adb -s emu-1 shell settings get global window_animation_scale",
			"adb -s emu-1 shell settings get global transition_animation_scale",
			"adb -s emu-1 shell settings get global animator_duration_scale",
			"adb -s emu-1 shell am force-stop nz.co.delacour.warden.example",
		]);
		expect(r.success).toBe(true);
	});

	test("android: force-stops every installed driver app of any framework before the app", async () => {
		const exec = make();
		await isolate({
			...base(exec),
			platform: "android",
			udid: "emu-1",
			allDrivers: ["com.argent.*", "com.example.driver*"],
		});
		const all = cmds(exec);
		const driver = all.indexOf("adb -s emu-1 shell am force-stop com.example.driver-ios");
		expect(driver).toBeGreaterThan(-1);
		expect(driver).toBeLessThan(all.indexOf("adb -s emu-1 shell am force-stop nz.co.delacour.warden.example"));
		expect(all.some((c) => c.includes("force-stop other"))).toBe(false);
	});

	test("android warm: no uninstall, no reboot", async () => {
		const exec = make();
		await isolate({ ...base(exec), platform: "android", udid: "emu-1" });
		expect(cmds(exec).at(-1)).toBe("adb -s emu-1 shell am force-stop nz.co.delacour.warden.example");
		expect(cmds(exec).some((c) => c.includes("reboot") || c.includes("uninstall"))).toBe(false);
	});

	test("reboot failure is an error", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "xcrun", match: (a) => a[1] === "boot", result: { code: 1, stderr: "boom" } },
		]);
		const r = await isolate({ ...base(exec), rebootBetween: true });
		expect(r).toEqual({ success: false, error: "simctl boot failed: boom" });
	});
});

const SCALES = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];
const settingCalls = (exec: FakeExec, verb: string) =>
	exec.calls
		.filter((c) => c.cmd === "adb" && c.args[3] === "settings" && c.args[4] === verb)
		.map((c) => c.args.slice(5).join(" "));

describe("animation scales", () => {
	test("the three settings warden's driver zeroes", () => {
		const names: string[] = [...ANIMATION_SETTINGS];
		expect(names).toEqual(SCALES);
	});

	test("read: values as printed, `null` as unset", async () => {
		const settings: Settings = new Map([
			["window_animation_scale", "0.5"],
			["animator_duration_scale", "1"],
		]);
		const r = await readAnimationScales(make({ settings }), "emu-1");
		expect(r).toEqual({
			success: true,
			data: { window_animation_scale: "0.5", transition_animation_scale: undefined, animator_duration_scale: "1" },
		});
	});

	test("read: a failing adb or a non-numeric value is an error (the value is later passed to a device shell)", async () => {
		const down = fakeExec([{ cmd: "adb", result: { code: 1, stderr: "device offline" } }]);
		const a = await readAnimationScales(down, "emu-1");
		expect(a.success).toBe(false);
		const settings: Settings = allScales("1.0");
		settings.set("window_animation_scale", "1.0; reboot");
		const b = await readAnimationScales(make({ settings }), "emu-1");
		expect(b).toEqual({ success: false, error: "window_animation_scale: unexpected value '1.0; reboot'" });
	});

	test("record: the first reading wins, later calls keep it", async () => {
		const settings = allScales("1.0");
		const exec = make({ settings });
		const baselines: AnimationBaselines = new Map();
		await recordAnimationScales(exec, "emu-1", baselines);
		for (const key of SCALES) settings.set(key, "0");
		const again = await recordAnimationScales(exec, "emu-1", baselines);
		expect(again.success && again.data.window_animation_scale).toBe("1.0");
		expect(baselines.get("emu-1")?.animator_duration_scale).toBe("1.0");
		expect(settingCalls(exec, "get")).toHaveLength(3);
	});

	test("restore: without a recorded baseline it does nothing", async () => {
		const exec = make();
		const r = await restoreAnimationScales(exec, "emu-1", new Map());
		expect(r).toEqual({ success: true, data: [] });
		expect(exec.calls).toHaveLength(0);
	});

	test("restore: puts back only the scales that differ and says what changed", async () => {
		const settings = allScales("1.0");
		const exec = make({ settings });
		const baselines: AnimationBaselines = new Map();
		await recordAnimationScales(exec, "emu-1", baselines);
		settings.set("window_animation_scale", "0");
		settings.set("animator_duration_scale", "0");
		const r = await restoreAnimationScales(exec, "emu-1", baselines);
		expect(r).toEqual({
			success: true,
			data: ["window_animation_scale 0 -> 1.0", "animator_duration_scale 0 -> 1.0"],
		});
		expect(settingCalls(exec, "put")).toEqual([
			"global window_animation_scale 1.0",
			"global animator_duration_scale 1.0",
		]);
		expect([...settings.entries()]).toEqual([...allScales("1.0").entries()]);
	});

	test("restore: a scale that was unset is deleted again, not written", async () => {
		const settings: Settings = new Map([["window_animation_scale", "1.0"]]);
		const exec = make({ settings });
		const baselines: AnimationBaselines = new Map();
		await recordAnimationScales(exec, "emu-1", baselines);
		for (const key of SCALES) settings.set(key, "0");
		const r = await restoreAnimationScales(exec, "emu-1", baselines);
		expect(r.success && r.data).toEqual([
			"window_animation_scale 0 -> 1.0",
			"transition_animation_scale 0 -> unset",
			"animator_duration_scale 0 -> unset",
		]);
		expect(settingCalls(exec, "delete")).toEqual([
			"global transition_animation_scale",
			"global animator_duration_scale",
		]);
		expect(settings.has("transition_animation_scale")).toBe(false);
	});

	test("restore: a failed write is an error naming the setting", async () => {
		const settings = allScales("1.0");
		const baselines: AnimationBaselines = new Map();
		await recordAnimationScales(make({ settings }), "emu-1", baselines);
		for (const key of SCALES) settings.set(key, "0");
		const exec = fakeExec([
			...settingsRules(settings).slice(0, 1),
			{ cmd: "adb", match: (a) => a[4] === "put", result: { code: 1, stderr: "denied" } },
		]);
		const r = await restoreAnimationScales(exec, "emu-1", baselines);
		expect(r.success).toBe(false);
		expect(!r.success && r.error).toContain("window_animation_scale");
	});

	test("isolate (android) records on the first call and writes nothing", async () => {
		const exec = make();
		const input = { ...base(exec), platform: "android" as const, udid: "emu-1" };
		const r = await isolate(input);
		expect(r.success).toBe(true);
		expect(input.animationBaselines.get("emu-1")).toEqual({
			window_animation_scale: "1.0",
			transition_animation_scale: "1.0",
			animator_duration_scale: "1.0",
		});
		expect(settingCalls(exec, "put")).toEqual([]);
	});

	test("isolate (android) undoes what the previous framework did, before the app is stopped", async () => {
		const settings = allScales("1.0");
		const input = { ...base(make({ settings })), platform: "android" as const, udid: "emu-1" };
		const lines: string[] = [];
		await isolate({ ...input, log: (l) => lines.push(l) });
		for (const key of SCALES) settings.set(key, "0");
		const second = make({ settings });
		const r = await isolate({ ...input, exec: second, log: (l) => lines.push(l) });
		expect(r.success).toBe(true);
		const all = cmds(second);
		const lastPut = all.indexOf("adb -s emu-1 shell settings put global animator_duration_scale 1.0");
		expect(lastPut).toBeGreaterThan(-1);
		expect(lastPut).toBeLessThan(all.indexOf("adb -s emu-1 shell am force-stop nz.co.delacour.warden.example"));
		expect([...settings.values()]).toEqual(["1.0", "1.0", "1.0"]);
		expect(lines).toContain("restored animation scale window_animation_scale 0 -> 1.0");
	});

	test("isolate (android) with unreadable settings logs and carries on", async () => {
		const exec = fakeExec([
			{ cmd: "ps", result: { stdout: fx("ps.txt") } },
			{ cmd: "adb", match: (a) => a[4] === "get", result: { code: 1, stderr: "offline" } },
			{ cmd: "adb", result: {} },
			{ cmd: "bun", result: {} },
		]);
		const lines: string[] = [];
		const r = await isolate({ ...base(exec), platform: "android", udid: "emu-1", log: (l) => lines.push(l) });
		expect(r.success).toBe(true);
		expect(lines.some((l) => l.startsWith("animation scales:"))).toBe(true);
	});

	test("isolate (ios) never touches device settings", async () => {
		const exec = make();
		await isolate(base(exec));
		expect(exec.calls.some((c) => c.args.includes("settings"))).toBe(false);
	});
});
