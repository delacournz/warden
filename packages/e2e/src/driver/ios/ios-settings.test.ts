import { describe, expect, test } from "bun:test";
import type { LaunchSettings } from "@delacour/warden-core/conditions/launch-settings";
import { type ExecCall, type FakeExecHandler, fakeExec, joined } from "./exec.testing";
import {
	contentSizeArgv,
	contrastArgv,
	createIosSettings,
	launchExtras,
	privacyArgv,
	pushArgv,
	statusBarBatteryArgv,
	withStagedSettings,
} from "./ios-settings";

const UDID = "UDID-1";
const APP = "com.example.app";

function harness(opts: { last?: string; fail?: string; missing?: boolean } = {}) {
	const calls: ExecCall[] = [];
	let staged: LaunchSettings = {};
	const exec = fakeExec(
		[
			...(opts.missing
				? [["xcrun simctl spawn", { exitCode: 1, stderr: "pair of (a, b) does not exist" }] as FakeExecHandler]
				: []),
			["xcrun", opts.fail ? { exitCode: 1, stderr: "boom" } : {}],
			["sh", {}],
		],
		calls
	);
	const settings = createIosSettings({
		udid: UDID,
		exec,
		lastBundle: () => opts.last,
		defaultBundle: APP,
		staged: {
			read: () => staged,
			write: (next) => {
				staged = next;
				return undefined;
			},
		},
	});
	return { settings, calls, staged: () => staged };
}

describe("ios argv", () => {
	test("privacy grant, revoke and reset", () => {
		expect(privacyArgv(UDID, "granted", "location", APP)).toEqual([
			"xcrun",
			"simctl",
			"privacy",
			UDID,
			"grant",
			"location",
			APP,
		]);
		expect(privacyArgv(UDID, "denied", "photos", APP).slice(4, 6)).toEqual(["revoke", "photos"]);
		expect(privacyArgv(UDID, "unset", "microphone", APP).slice(4, 6)).toEqual(["reset", "microphone"]);
	});
	test("ui and status bar", () => {
		expect(contentSizeArgv(UDID, "accessibility-large")).toEqual([
			"xcrun",
			"simctl",
			"ui",
			UDID,
			"content_size",
			"accessibility-large",
		]);
		expect(contrastArgv(UDID, true).slice(4)).toEqual(["increase_contrast", "enabled"]);
		expect(statusBarBatteryArgv(UDID, { level: 20, charging: false })).toEqual([
			"xcrun",
			"simctl",
			"status_bar",
			UDID,
			"override",
			"--batteryState",
			"discharging",
			"--batteryLevel",
			"20",
		]);
		expect(statusBarBatteryArgv(UDID, { level: 5 }).slice(5)).toEqual(["--batteryLevel", "5"]);
	});
	test("push pipes the payload on stdin through sh with positional args", () => {
		const argv = pushArgv(UDID, APP, { aps: { alert: "it's" } });
		expect(argv.slice(0, 3)).toEqual(["sh", "-c", 'printf %s "$1" | xcrun simctl push "$2" "$3" -']);
		expect(argv.slice(4)).toEqual(['{"aps":{"alert":"it\'s"}}', UDID, APP]);
	});
	test("launch extras: TZ env, language and locale args", () => {
		expect(launchExtras({ timezone: "Asia/Tokyo", locale: "fr-FR" })).toEqual({
			env: { TZ: "Asia/Tokyo" },
			args: ["-AppleLanguages", "(fr-FR)", "-AppleLocale", "fr_FR"],
		});
		expect(launchExtras({})).toEqual({ env: {}, args: [] });
	});
	test("staged settings merge into a launch, the caller's own env wins", () => {
		const merged = withStagedSettings(
			{ env: { TZ: "UTC", A: "1" }, args: ["--x"] },
			{ timezone: "Asia/Tokyo", locale: "de" }
		);
		expect(merged?.env).toEqual({ TZ: "UTC", A: "1" });
		expect(merged?.args).toEqual(["--x", "-AppleLanguages", "(de)", "-AppleLocale", "de"]);
		const plain = { relaunch: true };
		expect(withStagedSettings(plain, {})).toBe(plain);
	});
});

describe("ios permissions", () => {
	test("maps names to services and states to actions, for the named app", async () => {
		const h = harness();
		const r = await h.settings.permissions(
			{ location: "denied", locationAlways: "granted", microphone: "unset" },
			{ bundleId: "x.y" }
		);
		expect(r.success && r.data.applied).toHaveLength(3);
		expect(joined(h.calls)).toEqual([
			"xcrun simctl privacy UDID-1 revoke location x.y",
			"xcrun simctl privacy UDID-1 grant location-always x.y",
			"xcrun simctl privacy UDID-1 reset microphone x.y",
		]);
	});
	test("falls back to the last launched app, then the session's", async () => {
		const a = harness({ last: "last.app" });
		await a.settings.permissions({ photos: "granted" });
		expect(joined(a.calls)[0]).toContain("last.app");
		const b = harness();
		await b.settings.permissions({ photos: "granted" });
		expect(joined(b.calls)[0]).toContain(APP);
	});
	test("camera and notifications are skipped with a reason; all-skipped is E_UNSUPPORTED", async () => {
		const h = harness();
		const mixed = await h.settings.permissions({ camera: "granted", photos: "granted" });
		expect(mixed.success && mixed.data.skipped.map((s) => s.permission)).toEqual(["camera"]);
		const none = await h.settings.permissions({ notifications: "granted" });
		expect(!none.success && none.error.code).toBe("E_UNSUPPORTED");
		expect(h.calls).toHaveLength(1);
	});
	test("a privacy call killed by the timeout (tccd still starting) is tried once more", async () => {
		const calls: string[][] = [];
		const exits = [143, 0];
		const settings = createIosSettings({
			udid: UDID,
			exec: async (cmd) => {
				calls.push([...cmd]);
				return { exitCode: exits.shift() ?? 143, stdout: "", stderr: "" };
			},
			lastBundle: () => undefined,
			defaultBundle: APP,
		});
		const ok = await settings.permissions({ location: "denied" });
		expect(ok.success).toBe(true);
		expect(calls).toHaveLength(2);
		const twice = await settings.permissions({ location: "denied" });
		expect(!twice.success && twice.error.code).toBe("E_IO");
		expect(calls).toHaveLength(4);
	});
	test("a failing simctl is E_IO with its output", async () => {
		const h = harness({ fail: "x" });
		const r = await h.settings.permissions({ photos: "granted" });
		expect(!r.success && r.error.code).toBe("E_IO");
		expect(!r.success && r.error.message).toContain("boom");
	});
});

describe("ios timezone and locale", () => {
	test("are staged for the next launch, not run", async () => {
		const h = harness();
		const tz = await h.settings.timezone("Asia/Tokyo");
		expect(tz.success && tz.data).toEqual({ timezone: "Asia/Tokyo", appliesOnLaunch: true });
		const loc = await h.settings.locale("fr-FR");
		expect(loc.success && loc.data).toMatchObject({ locale: "fr-FR", appliesOnLaunch: true });
		expect(h.staged()).toEqual({ timezone: "Asia/Tokyo", locale: "fr-FR" });
		expect(h.calls).toEqual([]);
		await h.settings.timezone(null);
		expect(h.staged()).toEqual({ locale: "fr-FR" });
	});
	test("a bad timezone or locale is E_BAD_REQUEST", async () => {
		const h = harness();
		const tz = await h.settings.timezone("Mars/Olympus");
		expect(!tz.success && tz.error.code).toBe("E_BAD_REQUEST");
		const loc = await h.settings.locale("not a locale");
		expect(!loc.success && loc.error.code).toBe("E_BAD_REQUEST");
		expect(h.staged()).toEqual({});
	});
});

describe("ios a11y", () => {
	test("text size by name or by scale and contrast go through simctl ui", async () => {
		const h = harness();
		const r = await h.settings.a11y({ textSize: 1.9, contrast: "increased" });
		expect(r.success && r.data.applied).toEqual(["textSize", "contrast"]);
		expect(r.success && r.data.skipped).toEqual([]);
		expect(joined(h.calls)).toEqual([
			"xcrun simctl ui UDID-1 content_size accessibility-large",
			"xcrun simctl ui UDID-1 increase_contrast enabled",
		]);
	});
	test("reduce motion, bold, transparency, shapes, colour and labels are a defaults write each, applied", async () => {
		const h = harness();
		const r = await h.settings.a11y({
			reduceMotion: true,
			boldText: true,
			reduceTransparency: true,
			buttonShapes: false,
			differentiateWithoutColor: true,
			onOffLabels: true,
		});
		expect(r.success && r.data.applied).toEqual([
			"reduceMotion",
			"boldText",
			"reduceTransparency",
			"buttonShapes",
			"differentiateWithoutColor",
			"onOffLabels",
		]);
		expect(r.success && r.data.skipped).toEqual([]);
		expect(joined(h.calls)).toEqual([
			"xcrun simctl spawn UDID-1 defaults write com.apple.Accessibility ReduceMotionEnabled -bool YES",
			"xcrun simctl spawn UDID-1 defaults write com.apple.Accessibility EnhancedTextLegibilityEnabled -bool YES",
			"xcrun simctl spawn UDID-1 defaults write com.apple.Accessibility EnhancedBackgroundContrastEnabled -bool YES",
			"xcrun simctl spawn UDID-1 defaults write com.apple.Accessibility ButtonShapesEnabled -bool NO",
			"xcrun simctl spawn UDID-1 defaults write com.apple.Accessibility DifferentiateWithoutColor -bool YES",
			"xcrun simctl spawn UDID-1 defaults write com.apple.Accessibility IncreaseButtonLegibilityEnabled -bool YES",
		]);
	});
	test("screenReader writes VoiceOverTouchEnabled and reports the simulated voiceover engine", async () => {
		const h = harness();
		const r = await h.settings.a11y({ screenReader: true });
		expect(r.success && r.data.applied).toEqual(["screenReader"]);
		expect(r.success && r.data.screenReader).toEqual({ mode: "simulated", engine: "voiceover" });
		expect(joined(h.calls)).toEqual([
			"xcrun simctl spawn UDID-1 defaults write com.apple.Accessibility VoiceOverTouchEnabled -bool YES",
		]);
		const off = await harness().settings.a11y({ screenReader: false });
		expect(off.success && off.data.screenReader).toEqual({ mode: "off" });
	});
	test("Android-only settings are skipped with a reason; only those is E_UNSUPPORTED", async () => {
		const mixed = await harness().settings.a11y({ boldText: true, colorInversion: true });
		expect(mixed.success && mixed.data.skipped).toEqual([{ setting: "colorInversion", reason: "Android only" }]);
		const only = await harness().settings.a11y({ highContrastText: true });
		expect(!only.success && only.error.code).toBe("E_UNSUPPORTED");
	});
	test("a failing defaults write is E_IO", async () => {
		const r = await harness({ fail: "x" }).settings.a11y({ boldText: true });
		expect(!r.success && r.error.code).toBe("E_IO");
	});
	test("null puts text size and contrast back and deletes every key warden manages, a missing key tolerated", async () => {
		const h = harness();
		await h.settings.a11y(null);
		const lines = joined(h.calls);
		expect(lines.slice(0, 3)).toEqual([
			"xcrun simctl ui UDID-1 content_size large",
			"xcrun simctl ui UDID-1 increase_contrast disabled",
			"xcrun simctl spawn UDID-1 defaults delete com.apple.Accessibility ReduceMotionEnabled",
		]);
		expect(lines).toHaveLength(9);
		expect(lines.at(-1)).toContain("VoiceOverTouchEnabled");
		const gone = await harness({ missing: true }).settings.a11y(null);
		expect(gone.success).toBe(true);
	});
	test("an unknown text size is E_BAD_REQUEST", async () => {
		const r = await harness().settings.a11y({ textSize: "huge" as never });
		expect(!r.success && r.error.code).toBe("E_BAD_REQUEST");
	});
});

describe("ios battery, memory warning, push", () => {
	test("battery is cosmetic and says so", async () => {
		const h = harness();
		const r = await h.settings.battery({ level: 15, charging: false });
		expect(r.success && r.data).toEqual({ level: 15, charging: false, cosmetic: true });
		const off = await h.settings.battery(null);
		expect(off.success && off.data.cosmetic).toBe(true);
		expect(joined(h.calls)[1]).toBe("xcrun simctl status_bar UDID-1 clear");
	});
	test("battery validates the level and needs something to set", async () => {
		const h = harness();
		const bad = await h.settings.battery({ level: 101 });
		expect(!bad.success && bad.error.code).toBe("E_BAD_REQUEST");
		const empty = await h.settings.battery({});
		expect(!empty.success && empty.error.code).toBe("E_BAD_REQUEST");
		expect(h.calls).toEqual([]);
	});
	test("memory warning is E_UNSUPPORTED with the reason", async () => {
		const r = await harness().settings.memoryWarning();
		expect(!r.success && r.error.code).toBe("E_UNSUPPORTED");
		expect(!r.success && r.error.message).toContain("lowmemory");
	});
	test("push delivers a payload, and rejects one without aps", async () => {
		const h = harness();
		const ok = await h.settings.push({ aps: { alert: "hi" } });
		expect(ok.success).toBe(true);
		expect(h.calls[0]?.cmd.slice(0, 2)).toEqual(["sh", "-c"]);
		const bad = await h.settings.push({ nope: 1 } as never);
		expect(!bad.success && bad.error.code).toBe("E_BAD_REQUEST");
		const big = await h.settings.push({ aps: { alert: "x".repeat(5000) } });
		expect(!big.success && big.error.message).toContain("4096");
	});
});
