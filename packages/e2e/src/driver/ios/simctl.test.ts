import { describe, expect, test } from "bun:test";
import type { ResetFs } from "@delacour/warden-core/builds/install";
import { type ExecCall, fakeExec, joined } from "./exec.testing";
import {
	appearanceArgv,
	automationArgv,
	createSimctl,
	launchArgv,
	launchEnv,
	parseRunning,
	pbcopyArgv,
	screenshotArgv,
	simctlFailure,
	statusBarOverrideArgv,
} from "./simctl";

const UDID = "UDID-1";
const BUNDLE = "nz.co.delacour.warden.example";

function harness(handlers: Parameters<typeof fakeExec>[0]) {
	const calls: ExecCall[] = [];
	const simctl = createSimctl({ udid: UDID, exec: fakeExec(handlers, calls), env: {} });
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

	test("clipboard round trip", async () => {
		const h = harness([
			["sh -c", {}],
			["xcrun simctl pbpaste", { stdout: "hello\n" }],
		]);
		expect((await h.simctl.pbcopy("hello")).success).toBe(true);
		expect(await h.simctl.pbpaste()).toEqual({ success: true, data: "hello\n" });
	});

	test("appearance reads and sets", async () => {
		const h = harness([["xcrun simctl ui UDID-1 appearance", { stdout: "dark\n" }]]);
		expect(await h.simctl.appearance()).toEqual({ success: true, data: "dark" });
		expect(await h.simctl.appearance("light")).toEqual({ success: true, data: "light" });
		const weird = harness([["xcrun simctl ui", { stdout: "unsupported\n" }]]);
		const result = await weird.simctl.appearance();
		expect(!result.success && result.error.code).toBe("E_UNSUPPORTED");
	});

	test("status bar override and clear", async () => {
		const h = harness([["xcrun simctl status_bar", {}]]);
		await h.simctl.statusBar();
		await h.simctl.statusBar("clear");
		expect(joined(h.calls)[0]).toContain("override");
		expect(joined(h.calls)[1]).toBe(`xcrun simctl status_bar ${UDID} clear`);
	});

	test("enableAutomation writes the Accessibility default", async () => {
		const h = harness([["xcrun simctl spawn", {}]]);
		expect((await h.simctl.enableAutomation()).success).toBe(true);
		expect(joined(h.calls)[0]).toContain("AutomationEnabled -bool true");
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
