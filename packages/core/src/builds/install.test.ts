import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import { appMatchesArtifact, installApp, isAppInstalled, type ResetFs, resetAppData, uninstallApp } from "./install";

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

describe("appMatchesArtifact", () => {
	const plist = (version: string) => JSON.stringify({ CFBundleVersion: version, CFBundleExecutable: "App" });
	const world = (
		installed: { version: string; exe: string; js?: string },
		cached = { version: "7", exe: "100", js: "9" }
	) =>
		exec({
			"xcrun simctl get_app_container U1 com.x": { stdout: "/dev/App.app\n" },
			"plutil -convert json -o - /dev/App.app/Info.plist": { stdout: plist(installed.version) },
			"plutil -convert json -o - /cache/App.app/Info.plist": { stdout: plist(cached.version) },
			"stat -f %z /dev/App.app/App": { stdout: `${installed.exe}\n` },
			"stat -f %z /cache/App.app/App": { stdout: `${cached.exe}\n` },
			...(installed.js ? { "stat -f %z /dev/App.app/main.jsbundle": { stdout: `${installed.js}\n` } } : {}),
			"stat -f %z /cache/App.app/main.jsbundle": { stdout: `${cached.js}\n` },
		});

	test("same version, binary and JS bundle → match", async () => {
		const e = world({ version: "7", exe: "100", js: "9" });
		expect(await appMatchesArtifact({ exec: e, env }, ios, "com.x", "/cache/App.app")).toEqual({
			success: true,
			data: true,
		});
	});

	test("different CFBundleVersion, binary size or JS bundle → no match", async () => {
		for (const installed of [
			{ version: "8", exe: "100", js: "9" },
			{ version: "7", exe: "101", js: "9" },
			{ version: "7", exe: "100", js: "10" },
			{ version: "7", exe: "100" },
		]) {
			const res = await appMatchesArtifact({ exec: world(installed), env }, ios, "com.x", "/cache/App.app");
			expect(res).toEqual({ success: true, data: false });
		}
	});

	test("app missing or unreadable → no match; Android is not checked", async () => {
		expect(await appMatchesArtifact({ exec: exec({}), env }, ios, "com.x", "/cache/App.app")).toEqual({
			success: true,
			data: false,
		});
		expect(await appMatchesArtifact({ exec: exec({}), env }, android, "com.x", "/cache/a.apk")).toEqual({
			success: true,
			data: true,
		});
	});
});

const META = ".com.apple.mobile_container_manager.metadata.plist";

/** Exact-match exec: argv joined → result; unknown commands succeed with empty output. */
function exactExec(table: Record<string, Partial<ExecResult>>, calls: string[]): Exec {
	return async (cmd) => {
		const joined = cmd.join(" ");
		calls.push(joined);
		return { exitCode: 0, stdout: "", stderr: "", ...table[joined] };
	};
}

function fakeFs(dirs: Record<string, string[]>, log: string[]): ResetFs {
	return {
		readdir: async (dir) => dirs[dir] ?? [],
		rm: async (path) => {
			log.push(`rm ${path}`);
		},
		mkdir: async (path) => {
			log.push(`mkdir ${path}`);
		},
	};
}

describe("resetAppData", () => {
	const dataCmd = "xcrun simctl get_app_container U1 com.x data";
	const groupsCmd = "xcrun simctl get_app_container U1 com.x groups";
	const base = {
		"xcrun simctl get_app_container U1 com.x": { stdout: "/p/App.app" },
		[dataCmd]: { stdout: "/data\n" },
	};

	test("iOS: terminate, defaults delete, wipe data keeping metadata, groups, privacy reset (in order)", async () => {
		const calls: string[] = [];
		const fsLog: string[] = [];
		const e = exactExec({ ...base, [groupsCmd]: { stdout: "group.com.x\t/groups/g1\n" } }, calls);
		const fs = fakeFs({ "/data": [META, "Documents", "Library"], "/groups/g1": [META, "shared.db"] }, fsLog);
		const res = await resetAppData({ exec: e, env, fs }, ios, "com.x");
		expect(res).toEqual({ success: true, data: undefined });
		expect(calls).toEqual([
			"xcrun simctl get_app_container U1 com.x",
			"xcrun simctl terminate U1 com.x",
			"xcrun simctl spawn U1 defaults delete com.x",
			dataCmd,
			groupsCmd,
			"xcrun simctl privacy U1 reset all com.x",
		]);
		expect(fsLog).toEqual([
			"rm /data/Documents",
			"rm /data/Library",
			"mkdir /data/Documents",
			"mkdir /data/Library/Caches",
			"mkdir /data/Library/Preferences",
			"mkdir /data/tmp",
			"rm /groups/g1/shared.db",
		]);
	});

	test("iOS: terminate / defaults delete / groups failures are ignored", async () => {
		const calls: string[] = [];
		const e = exactExec(
			{
				...base,
				"xcrun simctl terminate U1 com.x": { exitCode: 3 },
				"xcrun simctl spawn U1 defaults delete com.x": { exitCode: 1 },
				[groupsCmd]: { exitCode: 2 },
			},
			calls
		);
		const res = await resetAppData({ exec: e, env, fs: fakeFs({ "/data": ["a"] }, []) }, ios, "com.x");
		expect(res.success).toBe(true);
	});

	test("iOS: no groups output is fine", async () => {
		const fsLog: string[] = [];
		const e = exactExec({ ...base, [groupsCmd]: { stdout: "\n" } }, []);
		const res = await resetAppData({ exec: e, env, fs: fakeFs({ "/data": [] }, fsLog) }, ios, "com.x");
		expect(res.success).toBe(true);
		expect(fsLog.filter((l) => l.startsWith("rm"))).toEqual([]);
	});

	test("iOS: empty data container path → error", async () => {
		const e = exactExec({ ...base, [dataCmd]: { stdout: "" } }, []);
		const res = await resetAppData({ exec: e, env, fs: fakeFs({}, []) }, ios, "com.x");
		expect(res.success).toBe(false);
	});

	test("iOS: privacy reset failure → error", async () => {
		const e = exactExec({ ...base, "xcrun simctl privacy U1 reset all com.x": { exitCode: 1, stderr: "nope" } }, []);
		const res = await resetAppData({ exec: e, env, fs: fakeFs({}, []) }, ios, "com.x");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("privacy reset failed");
	});

	test("iOS: keychain reset only when asked", async () => {
		const without: string[] = [];
		await resetAppData({ exec: exactExec(base, without), env, fs: fakeFs({}, []) }, ios, "com.x");
		expect(without).not.toContain("xcrun simctl keychain U1 reset");
		const withKc: string[] = [];
		const res = await resetAppData({ exec: exactExec(base, withKc), env, fs: fakeFs({}, []) }, ios, "com.x", {
			keychain: true,
		});
		expect(res.success).toBe(true);
		expect(withKc.at(-1)).toBe("xcrun simctl keychain U1 reset");
		const bad = exactExec({ ...base, "xcrun simctl keychain U1 reset": { exitCode: 1 } }, []);
		const failed = await resetAppData({ exec: bad, env, fs: fakeFs({}, []) }, ios, "com.x", { keychain: true });
		expect(failed.success).toBe(false);
	});

	test("not installed → error naming bundle id and device", async () => {
		const res = await resetAppData({ exec: exec({}), env, fs: fakeFs({}, []) }, ios, "com.x");
		expect(res).toEqual({ success: false, error: "com.x is not installed on U1" });
	});

	test("Android: pm clear Success → ok", async () => {
		const calls: string[] = [];
		const e = exactExec(
			{
				"adb -s emulator-5554 shell pm path com.x": { stdout: "package:/x" },
				"adb -s emulator-5554 shell pm clear com.x": { stdout: "Success\n" },
			},
			calls
		);
		const res = await resetAppData({ exec: e, env, fs: fakeFs({}, []) }, android, "com.x", { keychain: true });
		expect(res.success).toBe(true);
		expect(calls.at(-1)).toBe("adb -s emulator-5554 shell pm clear com.x");
	});

	test("Android: pm clear Failed → error", async () => {
		const e = exactExec(
			{
				"adb -s emulator-5554 shell pm path com.x": { stdout: "package:/x" },
				"adb -s emulator-5554 shell pm clear com.x": { stdout: "Failed\n" },
			},
			[]
		);
		const res = await resetAppData({ exec: e, env, fs: fakeFs({}, []) }, android, "com.x");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("pm clear failed");
	});
});
