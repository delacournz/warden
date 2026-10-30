import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import {
	appMatchesArtifact,
	type FileDigest,
	type FileSize,
	installApp,
	isAppInstalled,
	probeApp,
	type ResetFs,
	resetAppData,
	uninstallApp,
} from "./install";

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

describe("probeApp", () => {
	test("iOS: present with the container path the probe printed", async () => {
		const yes = exec({ "xcrun simctl get_app_container U1 com.x": { stdout: "/dev/App.app\n" } });
		expect(await probeApp({ exec: yes, env }, ios, "com.x")).toEqual({
			success: true,
			data: { present: true, container: "/dev/App.app" },
		});
		expect(await probeApp({ exec: exec({}), env }, ios, "com.x")).toEqual({ success: true, data: { present: false } });
	});

	test("Android: present, no container", async () => {
		const yes = exec({ "adb -s emulator-5554 shell pm path com.x": { stdout: "package:/data/app/base.apk\n" } });
		expect(await probeApp({ exec: yes, env }, android, "com.x")).toEqual({ success: true, data: { present: true } });
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

describe("installApp on a physical phone (PHY-2.5)", () => {
	const phone = { platform: "android" as const, deviceId: "R5CT1234ABC", physical: true };
	const installed = {
		"adb -s R5CT1234ABC install -r /c/app.apk": { stdout: "Success" },
		"adb -s R5CT1234ABC shell pm path": { stdout: "package:/x" },
	};
	const abis = (list: string) => ({
		"adb -s R5CT1234ABC shell getprop ro.product.cpu.abilist": { stdout: `${list}\n` },
	});
	const apk = (entries: string) => ({ "unzip -Z1 /c/app.apk": { stdout: entries } });

	test("an APK with no matching lib/<abi>/ is abi_mismatch, with a hint, and is never installed", async () => {
		const calls: string[] = [];
		const e = exec(
			{
				...installed,
				...abis("arm64-v8a,armeabi-v7a"),
				...apk("classes.dex\nlib/x86_64/libfoo.so\nlib/x86/libfoo.so\n"),
			},
			calls
		);
		const res = await installApp({ exec: e, env }, phone, "/c/app.apk", "com.x");
		expect(!res.success && res.error).toContain("abi_mismatch");
		expect(!res.success && res.error).toContain("x86_64");
		expect(!res.success && res.error).toContain("arm64-v8a");
		expect(!res.success && res.error).toMatch(/dev|release/);
		expect(calls.some((c) => c.includes(" install "))).toBe(false);
	});

	test("a matching ABI installs", async () => {
		const e = exec({ ...installed, ...abis("arm64-v8a,armeabi-v7a"), ...apk("lib/arm64-v8a/libfoo.so\n") });
		expect((await installApp({ exec: e, env }, phone, "/c/app.apk", "com.x")).success).toBe(true);
	});

	test("a pure-Java APK (no lib/) installs on any ABI", async () => {
		const e = exec({ ...installed, ...abis("arm64-v8a"), ...apk("classes.dex\nAndroidManifest.xml\n") });
		expect((await installApp({ exec: e, env }, phone, "/c/app.apk", "com.x")).success).toBe(true);
	});

	test("an APK or ABI list that cannot be read does not block the install", async () => {
		const e = exec({ ...installed });
		expect((await installApp({ exec: e, env }, phone, "/c/app.apk", "com.x")).success).toBe(true);
	});

	test("an emulator install makes no ABI check", async () => {
		const calls: string[] = [];
		const e = exec(
			{
				"adb -s emulator-5554 install -r /c/app.apk": { stdout: "Success" },
				"adb -s emulator-5554 shell pm path": { stdout: "package:/x" },
			},
			calls
		);
		await installApp({ exec: e, env }, android, "/c/app.apk", "com.x");
		expect(calls.some((c) => c.startsWith("unzip") || c.includes("abilist"))).toBe(false);
	});

	test("INSTALL_FAILED_UPDATE_INCOMPATIBLE says to uninstall it yourself and never uninstalls", async () => {
		const calls: string[] = [];
		const e = exec(
			{
				"adb -s R5CT1234ABC install -r": {
					stdout: "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.x signatures do not match]",
				},
			},
			calls
		);
		const res = await installApp({ exec: e, env }, phone, "/c/app.apk", "com.x");
		expect(!res.success && res.error).toContain("differently-signed");
		expect(!res.success && res.error).toContain("uninstall it yourself");
		expect(calls.some((c) => c.includes("uninstall"))).toBe(false);
	});

	test("the same message on an emulator target", async () => {
		const e = exec({ "adb -s emulator-5554 install -r": { stdout: "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]" } });
		const res = await installApp({ exec: e, env }, android, "/c/app.apk", "com.x");
		expect(!res.success && res.error).toContain("uninstall it yourself");
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

describe("appMatchesArtifact on Android", () => {
	const world = (deviceSha: string | undefined, cachedSha: string | null = "aaa") => {
		const calls: string[] = [];
		const fileDigest: FileDigest = async (path) => (path === "/cache/a.apk" ? (cachedSha ?? undefined) : undefined);
		const e = exec(
			{
				"adb -s emulator-5554 shell pm path com.x": {
					stdout: "package:/data/app/~~x==/com.x-y==/base.apk\n",
				},
				"adb -s emulator-5554 shell sha256sum /data/app/~~x==/com.x-y==/base.apk":
					deviceSha === undefined ? { exitCode: 1 } : { stdout: `${deviceSha}  /data/app/~~x==/com.x-y==/base.apk\n` },
			},
			calls
		);
		return { deps: { exec: e, env, fileDigest }, calls };
	};

	test("the installed base.apk has the cached apk's sha256 → match", async () => {
		const { deps } = world("aaa");
		expect(await appMatchesArtifact(deps, android, "com.x", "/cache/a.apk")).toEqual({ success: true, data: true });
	});

	test("another build of the same app (different digest) → no match", async () => {
		const { deps } = world("bbb");
		expect(await appMatchesArtifact(deps, android, "com.x", "/cache/a.apk")).toEqual({ success: true, data: false });
	});

	test("app missing, digest unreadable on the device or locally → no match (reinstall is the safe side)", async () => {
		expect(await appMatchesArtifact({ exec: exec({}), env }, android, "com.x", "/cache/a.apk")).toEqual({
			success: true,
			data: false,
		});
		for (const w of [world(undefined), world("aaa", null)]) {
			expect(await appMatchesArtifact(w.deps, android, "com.x", "/cache/a.apk")).toEqual({
				success: true,
				data: false,
			});
		}
	});
});

describe("appMatchesArtifact", () => {
	const plist = (version: string) => JSON.stringify({ CFBundleVersion: version, CFBundleExecutable: "App" });
	const world = (
		installed: { version: string; exe: string; js?: string },
		cached = { version: "7", exe: "100", js: "9" }
	) => {
		const calls: string[] = [];
		const sizes: Record<string, number> = {
			"/dev/App.app/App": Number(installed.exe),
			"/cache/App.app/App": Number(cached.exe),
			"/cache/App.app/main.jsbundle": Number(cached.js),
			...(installed.js ? { "/dev/App.app/main.jsbundle": Number(installed.js) } : {}),
		};
		const fileSize: FileSize = async (path) => sizes[path];
		const e = exec(
			{
				"xcrun simctl get_app_container U1 com.x": { stdout: "/dev/App.app\n" },
				"plutil -convert json -o - /dev/App.app/Info.plist": { stdout: plist(installed.version) },
				"plutil -convert json -o - /cache/App.app/Info.plist": { stdout: plist(cached.version) },
			},
			calls
		);
		return { deps: { exec: e, env, fileSize }, calls };
	};

	test("same version, binary and JS bundle → match", async () => {
		const { deps } = world({ version: "7", exe: "100", js: "9" });
		expect(await appMatchesArtifact(deps, ios, "com.x", "/cache/App.app")).toEqual({ success: true, data: true });
	});

	test("different CFBundleVersion, binary size or JS bundle → no match", async () => {
		for (const installed of [
			{ version: "8", exe: "100", js: "9" },
			{ version: "7", exe: "101", js: "9" },
			{ version: "7", exe: "100", js: "10" },
			{ version: "7", exe: "100" },
		]) {
			const { deps } = world(installed);
			expect(await appMatchesArtifact(deps, ios, "com.x", "/cache/App.app")).toEqual({ success: true, data: false });
		}
	});

	test("a container path from the earlier probe is reused: no second get_app_container", async () => {
		const { deps, calls } = world({ version: "7", exe: "100", js: "9" });
		const res = await appMatchesArtifact(deps, ios, "com.x", "/cache/App.app", "/dev/App.app");
		expect(res).toEqual({ success: true, data: true });
		expect(calls.some((c) => c.includes("get_app_container"))).toBe(false);
	});

	test("the whole already-installed check is three spawns: one probe, two plutil, no stat", async () => {
		const { deps, calls } = world({ version: "7", exe: "100", js: "9" });
		const probed = await probeApp(deps, ios, "com.x");
		if (!probed.success || !probed.data.container) throw new Error("probe failed");
		await appMatchesArtifact(deps, ios, "com.x", "/cache/App.app", probed.data.container);
		expect(calls).toHaveLength(3);
		expect(calls.filter((c) => c.startsWith("plutil"))).toHaveLength(2);
		expect(calls.some((c) => c.startsWith("stat"))).toBe(false);
	});

	test("file sizes are read in-process, not with `stat`", async () => {
		const { deps, calls } = world({ version: "7", exe: "100", js: "9" });
		await appMatchesArtifact(deps, ios, "com.x", "/cache/App.app");
		expect(calls.some((c) => c.startsWith("stat"))).toBe(false);
	});

	test("app missing or unreadable → no match", async () => {
		expect(await appMatchesArtifact({ exec: exec({}), env }, ios, "com.x", "/cache/App.app")).toEqual({
			success: true,
			data: false,
		});
	});

	test("the default file size reads the real filesystem", async () => {
		const missing = await appMatchesArtifact(
			{ exec: exec({ plutil: { stdout: plist("1") } }), env },
			ios,
			"com.x",
			"/nonexistent-warden/App.app",
			"/nonexistent-warden/Other.app"
		);
		expect(missing).toEqual({ success: true, data: false });
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
