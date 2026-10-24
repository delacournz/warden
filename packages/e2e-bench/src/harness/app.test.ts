import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFingerprint, installApp, parseEnsure, terminateApp } from "./app";
import { fakeExec } from "./exec";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "bench-app-"));
	dirs.push(d);
	return d;
}

describe("appFingerprint", () => {
	test("dir: stable, content and name sensitive", () => {
		const a = tmp();
		mkdirSync(join(a, "sub"));
		writeFileSync(join(a, "b.txt"), "bb");
		writeFileSync(join(a, "sub", "a.txt"), "a");
		const first = appFingerprint(a);
		expect(first.success && first.data.bytes).toBe(3);
		expect(appFingerprint(a)).toEqual(first);
		writeFileSync(join(a, "sub", "a.txt"), "z");
		const changed = appFingerprint(a);
		expect(changed.success && first.success && changed.data.sha256 !== first.data.sha256).toBe(true);
	});
	test("file (apk)", () => {
		const d = tmp();
		writeFileSync(join(d, "a.apk"), "apk");
		const r = appFingerprint(join(d, "a.apk"));
		expect(r.success && r.data.bytes).toBe(3);
	});
	test("missing path is an error", () => {
		expect(appFingerprint("/nonexistent/zzz").success).toBe(false);
	});
});

describe("installApp / terminateApp", () => {
	test("ios install", async () => {
		const exec = fakeExec([{ cmd: "xcrun", result: {} }]);
		expect((await installApp(exec, "ios", "U1", "/a.app")).success).toBe(true);
		expect(exec.calls[0]?.args).toEqual(["simctl", "install", "U1", "/a.app"]);
	});
	test("android install", async () => {
		const exec = fakeExec([{ cmd: "adb", result: {} }]);
		await installApp(exec, "android", "emu", "/a.apk");
		expect(exec.calls[0]?.args).toEqual(["-s", "emu", "install", "-r", "/a.apk"]);
	});
	test("install failure", async () => {
		expect(
			(await installApp(fakeExec([{ cmd: "xcrun", result: { code: 1, stderr: "bad" } }]), "ios", "U", "/a")).success
		).toBe(false);
	});
	test("ios terminate ignores not-running", async () => {
		const exec = fakeExec([{ cmd: "xcrun", result: { code: 3, stderr: "found nothing to terminate" } }]);
		expect((await terminateApp(exec, "ios", "U1", "b.id")).success).toBe(true);
	});
	test("ios terminate other failure is an error", async () => {
		const exec = fakeExec([{ cmd: "xcrun", result: { code: 1, stderr: "Invalid device" } }]);
		expect((await terminateApp(exec, "ios", "U1", "b.id")).success).toBe(false);
	});
	test("android force-stop", async () => {
		const exec = fakeExec([{ cmd: "adb", result: {} }]);
		expect((await terminateApp(exec, "android", "emu", "b.id")).success).toBe(true);
		expect(exec.calls[0]?.args).toEqual(["-s", "emu", "shell", "am", "force-stop", "b.id"]);
	});
});

describe("parseEnsure", () => {
	test("reads the ensure payload", () => {
		expect(parseEnsure(JSON.stringify({ appPath: "/a.app", hash: "h", source: "cache", installed: true }))).toEqual({
			appPath: "/a.app",
			hash: "h",
			source: "cache",
			installed: true,
		});
	});
	test("garbage is undefined", () => {
		expect(parseEnsure("nope")).toBeUndefined();
		expect(parseEnsure("{}")).toBeUndefined();
	});
});
