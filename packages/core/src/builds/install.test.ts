import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import { installApp, isAppInstalled, uninstallApp } from "./install";

function exec(handlers: Record<string, Partial<ExecResult>>, calls: string[] = []): Exec {
	return async (cmd) => {
		const joined = cmd.join(" ");
		calls.push(joined);
		const hit = Object.entries(handlers).find(([k]) => joined.startsWith(k));
		return hit ? { exitCode: 0, stdout: "", stderr: "", ...hit[1] } : { exitCode: 1, stdout: "", stderr: "no" };
	};
}

const ios = { platform: "ios" as const, deviceId: "U1" };
const android = { platform: "android" as const, deviceId: "emulator-5554" };
const env = {};

describe("isAppInstalled", () => {
	test("iOS: get_app_container exit code", async () => {
		const yes = exec({ "xcrun simctl get_app_container U1 com.x": { stdout: "/path/App.app\n" } });
		expect(await isAppInstalled({ exec: yes, env }, ios, "com.x")).toEqual({ success: true, data: true });
		expect(await isAppInstalled({ exec: exec({}), env }, ios, "com.x")).toEqual({ success: true, data: false });
	});

	test("Android: pm path prints package:", async () => {
		const yes = exec({ "adb -s emulator-5554 shell pm path com.x": { stdout: "package:/data/app/base.apk\n" } });
		expect(await isAppInstalled({ exec: yes, env }, android, "com.x")).toEqual({ success: true, data: true });
		const no = exec({ "adb -s emulator-5554 shell pm path com.x": { stdout: "" } });
		expect(await isAppInstalled({ exec: no, env }, android, "com.x")).toEqual({ success: true, data: false });
	});

	test("Android uses $ANDROID_HOME adb", async () => {
		const calls: string[] = [];
		await isAppInstalled({ exec: exec({}, calls), env: { ANDROID_HOME: "/sdk" } }, android, "com.x");
		expect(calls[0]).toBe("/sdk/platform-tools/adb -s emulator-5554 shell pm path com.x");
	});
});

describe("installApp", () => {
	test("iOS: simctl install then confirm", async () => {
		const calls: string[] = [];
		const e = exec(
			{ "xcrun simctl install U1 /c/App.app": {}, "xcrun simctl get_app_container U1 com.x": { stdout: "/p" } },
			calls
		);
		expect(await installApp({ exec: e, env }, ios, "/c/App.app", "com.x")).toEqual({ success: true, data: undefined });
		expect(calls).toEqual(["xcrun simctl install U1 /c/App.app", "xcrun simctl get_app_container U1 com.x"]);
	});

	test("Android: adb install -r; `Failure [` on exit 0 is an error", async () => {
		const ok = exec({
			"adb -s emulator-5554 install -r /c/app.apk": { stdout: "Success" },
			"adb -s emulator-5554 shell pm path": { stdout: "package:/x" },
		});
		expect((await installApp({ exec: ok, env }, android, "/c/app.apk", "com.x")).success).toBe(true);
		const bad = exec({
			"adb -s emulator-5554 install -r": { stdout: "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]" },
		});
		expect((await installApp({ exec: bad, env }, android, "/c/app.apk", "com.x")).success).toBe(false);
	});

	test("installed but bundle id absent → error mentioning the bundle id", async () => {
		const e = exec({ "xcrun simctl install": {} });
		const res = await installApp({ exec: e, env }, ios, "/c/App.app", "com.wrong");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("com.wrong");
	});
});

describe("uninstallApp", () => {
	test("iOS: simctl uninstall, then confirm it is gone", async () => {
		const calls: string[] = [];
		let present = true;
		const e: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined === "xcrun simctl uninstall U1 com.x") present = false;
			if (joined.startsWith("xcrun simctl get_app_container")) {
				return present ? { exitCode: 0, stdout: "/p", stderr: "" } : { exitCode: 1, stdout: "", stderr: "no" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		expect(await uninstallApp({ exec: e, env }, ios, "com.x")).toEqual({ success: true, data: undefined });
		expect(calls).toEqual([
			"xcrun simctl get_app_container U1 com.x",
			"xcrun simctl uninstall U1 com.x",
			"xcrun simctl get_app_container U1 com.x",
		]);
	});

	test("not installed → nothing to do (no uninstall call)", async () => {
		const calls: string[] = [];
		expect((await uninstallApp({ exec: exec({}, calls), env }, ios, "com.x")).success).toBe(true);
		expect(calls).toEqual(["xcrun simctl get_app_container U1 com.x"]);
	});

	test("Android: adb uninstall", async () => {
		const calls: string[] = [];
		let present = true;
		const e: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			if (joined === "adb -s emulator-5554 uninstall com.x") present = false;
			if (joined.includes("pm path")) {
				return { exitCode: 0, stdout: present ? "package:/x" : "", stderr: "" };
			}
			return { exitCode: 0, stdout: "Success", stderr: "" };
		};
		expect((await uninstallApp({ exec: e, env }, android, "com.x")).success).toBe(true);
		expect(calls).toContain("adb -s emulator-5554 uninstall com.x");
	});

	test("still present afterwards → error", async () => {
		const e = exec({ "xcrun simctl get_app_container": { stdout: "/p" }, "xcrun simctl uninstall": {} });
		const res = await uninstallApp({ exec: e, env }, ios, "com.x");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("com.x");
	});
});
