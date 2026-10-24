import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import { captureNativeLog, type NativeFs, type NativeTarget } from "./native-log";

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: "", stderr });

/** Scripted exec keyed by the joined argv prefix; unknown commands fail like a missing tool. */
function script(replies: Array<[prefix: string, result: ExecResult]>) {
	const calls: string[] = [];
	const exec: Exec = async (cmd) => {
		const line = cmd.join(" ");
		calls.push(line);
		return replies.find(([prefix]) => line.startsWith(prefix))?.[1] ?? fail(`no handler for ${line}`);
	};
	return { exec, calls };
}

function memoryFs(reports: Array<{ name: string; mtimeMs: number }> = []) {
	const written = new Map<string, string>();
	const copied: Array<[string, string]> = [];
	const fs: NativeFs = {
		listReports: () => reports,
		copy: (from, to) => void copied.push([from, to]),
		write: (path, text) => void written.set(path, text),
	};
	return { fs, written, copied };
}

const ios: NativeTarget = { platform: "ios", udid: "U-1", bundleId: "dev.example.app" };
const android: NativeTarget = { platform: "android", serial: "emulator-5554", pkg: "dev.example.app" };
const NOW = 1_000_000;
const SINCE = NOW - 12_400;

describe("captureNativeLog ios", () => {
	const replies: Array<[string, ExecResult]> = [
		["xcrun simctl get_app_container U-1 dev.example.app app", ok("/data/Example.app\n")],
		["plutil -extract CFBundleExecutable raw -o - /data/Example.app/Info.plist", ok("Example\n")],
		["xcrun simctl spawn U-1 log show", ok('{"eventMessage":"boom"}\n')],
	];

	test("writes native.log from log show scoped to the app process and the attempt window", async () => {
		const { exec, calls } = script(replies);
		const { fs, written } = memoryFs();
		const capture = await captureNativeLog(
			ios,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/out", sinceMs: SINCE, nowMs: NOW }
		);
		expect(capture).toEqual({ files: ["native.log"], problems: [] });
		expect(written.get("/out/native.log")).toBe('{"eventMessage":"boom"}\n');
		const show = calls.find((c) => c.includes("log show")) ?? "";
		expect(show).toContain("--style ndjson");
		expect(show).toContain("--last 18s");
		expect(show).toContain('process == "Example"');
	});

	test("copies only new .ips reports of the app", async () => {
		const { exec } = script(replies);
		const { fs, copied } = memoryFs([
			{ name: "Example-2026-10-24-101010.ips", mtimeMs: NOW - 2000 },
			{ name: "Example-old.ips", mtimeMs: SINCE - 60_000 },
			{ name: "Other-2026-10-24-101011.ips", mtimeMs: NOW - 1000 },
			{ name: "Example-notes.txt", mtimeMs: NOW },
		]);
		const capture = await captureNativeLog(
			ios,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/out", sinceMs: SINCE, nowMs: NOW }
		);
		expect(copied).toEqual([["/r/Example-2026-10-24-101010.ips", "/out/Example-2026-10-24-101010.ips"]]);
		expect(capture.files).toEqual(["native.log", "Example-2026-10-24-101010.ips"]);
	});

	test("unknown app container is a problem, not an exception", async () => {
		const { exec } = script([]);
		const { fs, written } = memoryFs();
		const capture = await captureNativeLog(
			ios,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/out", sinceMs: SINCE, nowMs: NOW }
		);
		expect(capture.files).toEqual([]);
		expect(capture.problems[0]).toContain("native log");
		expect(written.size).toBe(0);
	});

	test("a throwing exec is a problem", async () => {
		const exec: Exec = async () => {
			throw new Error("spawn failed");
		};
		const { fs } = memoryFs();
		const capture = await captureNativeLog(
			ios,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/out", sinceMs: SINCE, nowMs: NOW }
		);
		expect(capture.problems.join()).toContain("spawn failed");
	});
});

describe("captureNativeLog android", () => {
	test("logcat of the app pid since the attempt started, plus the crash buffer", async () => {
		const { exec, calls } = script([
			["adb -s emulator-5554 shell pidof dev.example.app", ok("4321\n")],
			["adb -s emulator-5554 logcat -d -v epoch --pid=4321", ok("main line\n")],
			["adb -s emulator-5554 logcat -d -b crash", ok("FATAL EXCEPTION\n")],
		]);
		const { fs, written } = memoryFs();
		const capture = await captureNativeLog(
			android,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/out", sinceMs: SINCE, nowMs: NOW }
		);
		expect(capture).toEqual({ files: ["native.log"], problems: [] });
		const text = written.get("/out/native.log") ?? "";
		expect(text).toContain("main line");
		expect(text).toContain("--- crash buffer ---");
		expect(text).toContain("FATAL EXCEPTION");
		expect(calls.find((c) => c.includes("--pid=4321"))).toContain("-T 982.600");
	});

	test("app already dead: main buffer unfiltered by pid, crash buffer still captured", async () => {
		const { exec, calls } = script([
			["adb -s emulator-5554 shell pidof", fail("")],
			["adb -s emulator-5554 logcat -d -v epoch", ok("system line\n")],
			["adb -s emulator-5554 logcat -d -b crash", ok("FATAL EXCEPTION\n")],
		]);
		const { fs, written } = memoryFs();
		await captureNativeLog(
			android,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/out", sinceMs: SINCE, nowMs: NOW }
		);
		expect(calls.some((c) => c.includes("--pid"))).toBe(false);
		expect(written.get("/out/native.log")).toContain("FATAL EXCEPTION");
	});

	test("adb failing is a problem", async () => {
		const { exec } = script([]);
		const { fs } = memoryFs();
		const capture = await captureNativeLog(
			android,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/out", sinceMs: SINCE, nowMs: NOW }
		);
		expect(capture.files).toEqual([]);
		expect(capture.problems[0]).toContain("native log");
	});
});
