import { describe, expect, test } from "bun:test";
import type { ResetFs } from "@delacour/warden-core/builds/install";
import { type ExecCall, fakeExec, joined } from "./exec.testing";
import {
	appearanceArgv,
	automationArgv,
	biometricEnrollArgvs,
	biometricEventArgv,
	biometricModalityOf,
	biometricStateArgv,
	createSimctl,
	devicectlPbcopyArgv,
	launchArgv,
	launchEnv,
	modelIdentifierArgv,
	parseRunning,
	pbcopyArgv,
	screenshotArgv,
	simctlFailure,
	statusBarOverrideArgv,
} from "./simctl";

const UDID = "UDID-1";
const BUNDLE = "nz.co.delacour.warden.example";
const automationPlist = "/devices/UDID-1/data/Library/Preferences/com.apple.Accessibility.plist";

function harness(handlers: Parameters<typeof fakeExec>[0]) {
	const calls: ExecCall[] = [];
	const simctl = createSimctl({ udid: UDID, exec: fakeExec(handlers, calls), env: {}, devicesRoot: "/devices" });
	return { simctl, calls };
}

describe("argv builders", () => {
	test("launch terminates a running instance by default and appends args", () => {
		expect(launchArgv(UDID, BUNDLE, { args: ["--flag", "x"] })).toEqual([
			"xcrun",
			"simctl",
			"launch",
			"--terminate-running-process",
			UDID,
			BUNDLE,
			"--flag",
			"x",
		]);
		expect(launchArgv(UDID, BUNDLE, { relaunch: false })).toEqual(["xcrun", "simctl", "launch", UDID, BUNDLE]);
	});

	test("launch env uses the SIMCTL_CHILD_ prefix", () => {
		expect(launchEnv({ A: "1", B: "two" })).toEqual({ SIMCTL_CHILD_A: "1", SIMCTL_CHILD_B: "two" });
		expect(launchEnv(undefined)).toEqual({});
	});

	test("pbcopy passes the text as $1, never inside the script", () => {
		const argv = pbcopyArgv(UDID, `it's "quoted" $(rm -rf /)`);
		expect(argv.slice(0, 3)).toEqual(["sh", "-c", 'printf %s "$1" | xcrun simctl pbcopy "$2"']);
		expect(argv.slice(3)).toEqual(["sh", `it's "quoted" $(rm -rf /)`, UDID]);
	});

	test("devicectl pbcopy passes the text as $1 too", () => {
		const argv = devicectlPbcopyArgv(UDID, "caf\u00e9 $(x)");
		expect(argv.slice(0, 3)).toEqual([
			"sh",
			"-c",
			'printf %s "$1" | xcrun devicectl device pasteboard copy --quiet --device "$2"',
		]);
		expect(argv.slice(3)).toEqual(["sh", "caf\u00e9 $(x)", UDID]);
	});

	test("appearance, screenshot, automation and status bar", () => {
		expect(appearanceArgv(UDID)).toEqual(["xcrun", "simctl", "ui", UDID, "appearance"]);
		expect(appearanceArgv(UDID, "dark")).toEqual(["xcrun", "simctl", "ui", UDID, "appearance", "dark"]);
		expect(screenshotArgv(UDID, "/tmp/a.png")).toEqual([
			"xcrun",
			"simctl",
			"io",
			UDID,
			"screenshot",
			"--type=png",
			"/tmp/a.png",
		]);
		expect(automationArgv(UDID).join(" ")).toBe(
			`xcrun simctl spawn ${UDID} defaults write com.apple.Accessibility AutomationEnabled -bool true`
		);
		expect(statusBarOverrideArgv(UDID).join(" ")).toContain("--time 9:41");
		expect(statusBarOverrideArgv(UDID, { time: "10:00", wifiBars: 1 }).join(" ")).toContain("--time 10:00");
	});
});

describe("biometric argv and modality", () => {
	test("enrollment is set then posted; state is read with -g", () => {
		expect(biometricEnrollArgvs(UDID, true).map((argv) => argv.join(" "))).toEqual([
			`xcrun simctl spawn ${UDID} notifyutil -s com.apple.BiometricKit.enrollmentChanged 1`,
			`xcrun simctl spawn ${UDID} notifyutil -p com.apple.BiometricKit.enrollmentChanged`,
		]);
		expect(biometricEnrollArgvs(UDID, false)[0]?.at(-1)).toBe("0");
		expect(biometricStateArgv(UDID).join(" ")).toBe(
			`xcrun simctl spawn ${UDID} notifyutil -g com.apple.BiometricKit.enrollmentChanged`
		);
	});

	test("match and nomatch name the modality's notification", () => {
		expect(biometricEventArgv(UDID, "face", "match").at(-1)).toBe("com.apple.BiometricKit_Sim.pearl.match");
		expect(biometricEventArgv(UDID, "face", "nomatch").at(-1)).toBe("com.apple.BiometricKit_Sim.pearl.nomatch");
		expect(biometricEventArgv(UDID, "fingerprint", "match").at(-1)).toBe(
			"com.apple.BiometricKit_Sim.fingerTouch.match"
		);
		expect(biometricEventArgv(UDID, "fingerprint", "nomatch").slice(0, 5)).toEqual([
			"xcrun",
			"simctl",
			"spawn",
			UDID,
			"notifyutil",
		]);
	});

	test("model identifier is read from the booted sim", () => {
		expect(modelIdentifierArgv(UDID)).toEqual(["xcrun", "simctl", "getenv", UDID, "SIMULATOR_MODEL_IDENTIFIER"]);
	});

	test("Touch ID models are fingerprint, the rest face", () => {
		for (const id of [
			"iPhone8,4",
			"iPhone9,1",
			"iPhone10,1",
			"iPhone10,5",
			"iPhone12,8",
			"iPhone14,6",
			"iPad13,18",
			"iPad14,8",
		]) {
			expect([id, biometricModalityOf(id)]).toEqual([id, "fingerprint"]);
		}
		for (const id of [
			"iPhone10,3",
			"iPhone10,6",
			"iPhone11,2",
			"iPhone14,7",
			"iPhone17,1",
			"iPad8,1",
			"iPad13,4",
			"iPad16,3",
		]) {
			expect([id, biometricModalityOf(id)]).toEqual([id, "face"]);
		}
		expect(biometricModalityOf("")).toBe("face");
	});
});

describe("parseRunning", () => {
	const out = [
		"PID\tStatus\tLabel",
		"4242\t0\tUIKitApplication:nz.co.x[abcd][rb-legacy]",
		"-\t0\tUIKitApplication:nz.co.y[ef01]",
	].join("\n");

	test("a numeric PID means running", () => {
		expect(parseRunning(out, "nz.co.x")).toBe(true);
	});
	test("loaded without a PID, absent, or only a prefix match are not running", () => {
		expect(parseRunning(out, "nz.co.y")).toBe(false);
		expect(parseRunning(out, "nz.co.z")).toBe(false);
		expect(parseRunning(out, "nz.co")).toBe(false);
	});
});

describe("simctlFailure", () => {
	const res = (stderr: string) => ({ exitCode: 1, stdout: "", stderr });
	test("classifies by simctl output", () => {
		expect(simctlFailure(["x"], res("Unable to launch in current state: Shutdown")).code).toBe("E_NOT_BOOTED");
		expect(simctlFailure(["x"], res("Invalid device: ABC")).code).toBe("E_UNKNOWN_DEVICE");
		expect(simctlFailure(["x"], res("FBSOpenApplicationServiceErrorDomain error 4"), true).code).toBe(
			"E_APP_UNAVAILABLE"
		);
		expect(simctlFailure(["x"], res("FBSOpenApplicationServiceErrorDomain error 4")).code).toBe("E_IO");
		expect(simctlFailure(["x"], res("boom")).code).toBe("E_IO");
	});
});

describe("createSimctl", () => {
	test("launch runs the argv with SIMCTL_CHILD_ env and maps a missing app", async () => {
		const ok = harness([["xcrun simctl launch", { stdout: `${BUNDLE}: 123` }]]);
		expect(await ok.simctl.launch(BUNDLE, { env: { K: "v" }, args: ["a"] })).toEqual({
			success: true,
			data: undefined,
		});
		expect(ok.calls[0]?.cmd).toEqual(["xcrun", "simctl", "launch", "--terminate-running-process", UDID, BUNDLE, "a"]);
		expect(ok.calls[0]?.opts?.env).toEqual({ SIMCTL_CHILD_K: "v" });

		const bad = harness([
			["xcrun simctl launch", { exitCode: 1, stderr: "FBSOpenApplicationServiceErrorDomain error 4" }],
		]);
		const failed = await bad.simctl.launch(BUNDLE);
		expect(!failed.success && failed.error.code).toBe("E_APP_UNAVAILABLE");
	});

	test("terminate treats 'nothing to terminate' as success", async () => {
		const gone = harness([["xcrun simctl terminate", { exitCode: 3, stderr: "found nothing to terminate" }]]);
		expect((await gone.simctl.terminate(BUNDLE)).success).toBe(true);
		const broken = harness([["xcrun simctl terminate", { exitCode: 3, stderr: "other" }]]);
		expect((await broken.simctl.terminate(BUNDLE)).success).toBe(false);
	});

	test("openUrl / install / uninstall", async () => {
		const h = harness([
			["xcrun simctl openurl", {}],
			["xcrun simctl install", {}],
			["xcrun simctl get_app_container", { stdout: "/containers/app\n" }],
			["xcrun simctl uninstall", {}],
		]);
		await h.simctl.openUrl("myapp://x");
		await h.simctl.install("/b/App.app");
		await h.simctl.uninstall(BUNDLE);
		expect(joined(h.calls)).toEqual([
			`xcrun simctl openurl ${UDID} myapp://x`,
			`xcrun simctl install ${UDID} /b/App.app`,
			`xcrun simctl get_app_container ${UDID} ${BUNDLE}`,
			`xcrun simctl uninstall ${UDID} ${BUNDLE}`,
		]);
	});

	test("uninstall of an absent app is a no-op", async () => {
		const h = harness([["xcrun simctl get_app_container", { exitCode: 2, stderr: "No such file" }]]);
		expect((await h.simctl.uninstall(BUNDLE)).success).toBe(true);
		expect(h.calls).toHaveLength(1);
	});

	test("isInstalled follows get_app_container; isRunning follows launchctl", async () => {
		const h = harness([
			["xcrun simctl get_app_container", { stdout: "/containers/app\n" }],
			["xcrun simctl spawn UDID-1 launchctl list", { stdout: `99\t0\tUIKitApplication:${BUNDLE}[1a2b]\n` }],
		]);
		expect(await h.simctl.isInstalled(BUNDLE)).toEqual({ success: true, data: true });
		expect(await h.simctl.isRunning(BUNDLE)).toEqual({ success: true, data: true });
		const none = harness([["xcrun simctl get_app_container", { exitCode: 2 }]]);
		expect(await none.simctl.isInstalled(BUNDLE)).toEqual({ success: true, data: false });
	});

	describe("pbcopy", () => {
		const DEVICECTL = 'sh -c printf %s "$1" | xcrun devicectl device pasteboard copy';
		const SIMCTL = 'sh -c printf %s "$1" | xcrun simctl pbcopy';

		test("writes through devicectl and confirms with pbpaste", async () => {
			const h = harness([
				[DEVICECTL, {}],
				["xcrun simctl pbpaste", { stdout: "caf\u00e9" }],
			]);
			expect(await h.simctl.pbcopy("caf\u00e9")).toEqual({ success: true, data: undefined });
			expect(joined(h.calls).filter((line) => line.startsWith("sh -c"))).toEqual([
				`${DEVICECTL} --quiet --device "$2" sh caf\u00e9 ${UDID}`,
			]);
			expect(joined(h.calls).filter((line) => line.startsWith("xcrun simctl pbpaste"))).toHaveLength(1);
			expect(await h.simctl.pbpaste()).toEqual({ success: true, data: "caf\u00e9" });
		});

		test("falls back to simctl pbcopy when devicectl cannot (older Xcode)", async () => {
			let copied = "";
			const h = harness([
				[DEVICECTL, { exitCode: 64, stderr: "Unexpected argument 'pasteboard'" }],
				[
					SIMCTL,
					(call) => {
						copied = call.cmd[4] ?? "";
						return {};
					},
				],
				["xcrun simctl pbpaste", () => ({ stdout: copied })],
			]);
			expect((await h.simctl.pbcopy("hello")).success).toBe(true);
			expect(joined(h.calls).filter((line) => line.startsWith("sh -c"))).toHaveLength(2);
		});

		test("fails, naming both channels, when the simulator pasteboard keeps other text", async () => {
			const h = harness([
				["sh -c", {}],
				["xcrun simctl pbpaste", { stdout: "Poole Dorset " }],
			]);
			const result = await h.simctl.pbcopy("caf\u00e9");
			expect(!result.success && result.error.code).toBe("E_IO");
			expect(!result.success && result.error.message).toMatch(/devicectl .*simctl pbcopy/);
			// never the text or the pasteboard: typeText carries passwords
			expect(!result.success && result.error.message).not.toContain("Poole");
			expect(!result.success && result.error.message).not.toContain("caf");
			expect(joined(h.calls).filter((line) => line.startsWith("sh -c"))).toHaveLength(2);
		});

		test("a pbpaste failure after the write is the failure", async () => {
			const h = harness([
				["sh -c", {}],
				["xcrun simctl pbpaste", { exitCode: 1, stderr: "nope" }],
			]);
			const result = await h.simctl.pbcopy("x");
			expect(result.success).toBe(false);
		});
	});

	test("appearance reads and sets", async () => {
		const h = harness([["xcrun simctl ui UDID-1 appearance", { stdout: "dark\n" }]]);
		expect(await h.simctl.appearance()).toEqual({ success: true, data: "dark" });
		expect(await h.simctl.appearance("light")).toEqual({ success: true, data: "light" });
		const weird = harness([["xcrun simctl ui", { stdout: "unsupported\n" }]]);
		const result = await weird.simctl.appearance();
		expect(!result.success && result.error.code).toBe("E_UNSUPPORTED");
	});

	test("biometrics: enroll sets then posts, state follows notifyutil -g, modality from the model", async () => {
		const h = harness([
			["xcrun simctl getenv", { stdout: "iPhone14,7\n" }],
			["xcrun simctl spawn UDID-1 notifyutil -g", { stdout: "com.apple.BiometricKit.enrollmentChanged 1\n" }],
			["xcrun simctl spawn", {}],
		]);
		expect(await h.simctl.biometrics("enroll")).toEqual({ success: true, data: { enrolled: true, modality: "face" } });
		const cmds = joined(h.calls).filter((c) => c.includes("notifyutil"));
		expect(cmds.slice(0, 2)).toEqual([
			`xcrun simctl spawn ${UDID} notifyutil -s com.apple.BiometricKit.enrollmentChanged 1`,
			`xcrun simctl spawn ${UDID} notifyutil -p com.apple.BiometricKit.enrollmentChanged`,
		]);
	});

	test("biometrics: unenroll writes 0; status reads 0 as not enrolled; Touch ID model posts fingerTouch", async () => {
		const h = harness([
			["xcrun simctl getenv", { stdout: "iPhone14,6\n" }],
			["xcrun simctl spawn UDID-1 notifyutil -g", { stdout: "com.apple.BiometricKit.enrollmentChanged 0\n" }],
			["xcrun simctl spawn", {}],
		]);
		expect(await h.simctl.biometrics("unenroll")).toEqual({
			success: true,
			data: { enrolled: false, modality: "fingerprint" },
		});
		expect(joined(h.calls)).toContain(
			`xcrun simctl spawn ${UDID} notifyutil -s com.apple.BiometricKit.enrollmentChanged 0`
		);
		await h.simctl.biometrics("match");
		await h.simctl.biometrics("fail");
		const posts = joined(h.calls).filter((c) => c.includes("fingerTouch"));
		expect(posts.map((c) => c.split(" ").at(-1))).toEqual([
			"com.apple.BiometricKit_Sim.fingerTouch.match",
			"com.apple.BiometricKit_Sim.fingerTouch.nomatch",
		]);
	});

	test("biometrics: an unreadable state or model is a typed error, an unknown model defaults to face", async () => {
		const bad = harness([["xcrun simctl", { exitCode: 1, stderr: "boom" }]]);
		const failed = await bad.simctl.biometrics("status");
		expect(!failed.success && failed.error.code).toBe("E_IO");
		const odd = harness([
			["xcrun simctl getenv", { exitCode: 1 }],
			["xcrun simctl spawn UDID-1 notifyutil -g", { stdout: "garbage\n" }],
		]);
		expect(await odd.simctl.biometrics("status")).toEqual({
			success: true,
			data: { enrolled: false, modality: "face" },
		});
	});

	test("status bar override and clear", async () => {
		const h = harness([["xcrun simctl status_bar", {}]]);
		await h.simctl.statusBar();
		await h.simctl.statusBar("clear");
		expect(joined(h.calls)[0]).toContain("override");
		expect(joined(h.calls)[1]).toBe(`xcrun simctl status_bar ${UDID} clear`);
	});

	test("enableAutomation writes the Accessibility default when the sim's plist does not have it", async () => {
		const h = harness([["xcrun simctl spawn", {}]]);
		expect((await h.simctl.enableAutomation()).success).toBe(true);
		expect(joined(h.calls).at(-1)).toContain("AutomationEnabled -bool true");
	});

	test("enableAutomation reads the sim's preference plist from the host first", async () => {
		const h = harness([["xcrun simctl spawn", {}]]);
		await h.simctl.enableAutomation();
		expect(h.calls[0]?.cmd).toEqual(["plutil", "-extract", "AutomationEnabled", "raw", "-o", "-", automationPlist]);
	});

	test("enableAutomation spawns nothing in the sim when the plist already says true", async () => {
		const h = harness([["plutil", { stdout: "true\n" }]]);
		expect((await h.simctl.enableAutomation()).success).toBe(true);
		expect(joined(h.calls)).toHaveLength(1);
		expect(joined(h.calls).some((line) => line.includes("xcrun"))).toBe(false);
	});

	test("a plist that says false still gets the write", async () => {
		const h = harness([
			["plutil", { stdout: "false\n" }],
			["xcrun simctl spawn", {}],
		]);
		await h.simctl.enableAutomation();
		expect(joined(h.calls).some((line) => line.includes("AutomationEnabled -bool true"))).toBe(true);
	});

	test("screenshot with a path writes it; without one reads back PNG bytes and cleans up", async () => {
		const h = harness([["xcrun simctl io", {}]]);
		expect(await h.simctl.screenshot("/out/a.png")).toEqual({ success: true, data: { path: "/out/a.png" } });

		const removed: string[] = [];
		const calls: ExecCall[] = [];
		const simctl = createSimctl({
			udid: UDID,
			exec: fakeExec([["xcrun simctl io", {}]], calls),
			scratchDir: async () => "/scratch/dir",
			readFile: async (path) => new TextEncoder().encode(`png@${path}`),
			rmDir: async (path) => {
				removed.push(path);
			},
		});
		const shot = await simctl.screenshot();
		expect(shot.success && new TextDecoder().decode(shot.data.png)).toBe("png@/scratch/dir/screen.png");
		expect(removed).toEqual(["/scratch/dir"]);
		expect(calls[0]?.cmd.at(-1)).toBe("/scratch/dir/screen.png");
	});

	test("clearData delegates to core resetAppData and honours keychain", async () => {
		const removed: string[] = [];
		const fs: ResetFs = {
			readdir: async () => ["Documents", "Library"],
			rm: async (path) => {
				removed.push(path);
			},
			mkdir: async () => undefined,
		};
		const calls: ExecCall[] = [];
		const simctl = createSimctl({
			udid: UDID,
			resetFs: fs,
			exec: fakeExec(
				[
					["xcrun simctl get_app_container UDID-1 nz.co.delacour.warden.example data", { stdout: "/data/container\n" }],
					["xcrun simctl get_app_container UDID-1 nz.co.delacour.warden.example groups", { stdout: "" }],
					["xcrun simctl get_app_container", { stdout: "/app\n" }],
					["xcrun simctl terminate", {}],
					["xcrun simctl spawn", {}],
					["xcrun simctl privacy", {}],
					["xcrun simctl keychain", {}],
				],
				calls
			),
		});
		expect((await simctl.clearData(BUNDLE, { keychain: true })).success).toBe(true);
		expect(removed).toEqual(["/data/container/Documents", "/data/container/Library"]);
		expect(joined(calls)).toContain(`xcrun simctl keychain ${UDID} reset`);
		const noKeychain = harness([["xcrun simctl get_app_container", { exitCode: 2 }]]);
		const missing = await noKeychain.simctl.clearData(BUNDLE);
		expect(!missing.success && missing.error.code).toBe("E_APP_UNAVAILABLE");
	});
});
