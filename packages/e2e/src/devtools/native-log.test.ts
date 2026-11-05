import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import {
	captureNativeLog,
	enableNativePrivateData,
	type NativeFs,
	type NativeTarget,
	realNativeFs,
} from "./native-log";

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
		expect(capture).toEqual({ files: ["native.log"], problems: [], tail: [] });
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
		expect(capture.files).toEqual(["native.log"]);
		expect(capture.problems).toEqual([]);
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

describe("realNativeFs", () => {
	test("write creates the attempt dir when nothing else did", () => {
		const root = mkdtempSync(join(tmpdir(), "wdn-native-"));
		try {
			realNativeFs().write(join(root, "a", "b", "native.log"), "x");
			expect(readFileSync(join(root, "a", "b", "native.log"), "utf8")).toBe("x");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("native log readability", () => {
	const line = (over: Record<string, unknown>) =>
		JSON.stringify({
			eventType: "logEvent",
			messageType: "Default",
			subsystem: "com.apple.securityd",
			category: "keychain",
			timestamp: "2026-11-05 18:45:56.413920+0000",
			eventMessage: "ok",
			...over,
		});
	const base = (show: string): Array<[string, ExecResult]> => [
		["xcrun simctl get_app_container U-1 dev.example.app app", ok("/data/Example.app\n")],
		["plutil -extract", ok("Example\n")],
		["xcrun simctl spawn U-1 log show", ok(show)],
	];
	const run = async (show: string) => {
		const { exec, calls } = script(base(show));
		const { fs, written } = memoryFs();
		const capture = await captureNativeLog(
			ios,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/out", sinceMs: SINCE, nowMs: NOW }
		);
		return { capture, calls, written };
	};

	test("reads inside the simulator, including info and debug lines", async () => {
		const { calls } = await run("");
		const show = calls.find((c) => c.includes("log show")) ?? "";
		expect(show.startsWith("xcrun simctl spawn U-1 log show")).toBe(true);
		expect(show).toContain("--info");
		expect(show).toContain("--debug");
	});

	test("returns a console tail of the readable lines, errors included", async () => {
		const { capture } = await run(
			[
				line({ messageType: "Error", eventMessage: "SecError -25300" }),
				line({ eventMessage: "<compose failure [shared UUID]>" }),
			].join("\n")
		);
		expect(capture.tail).toEqual(["18:45:56.413 error com.apple.securityd/keychain SecError -25300"]);
	});

	test("reports unresolved messages as a problem and keeps the file", async () => {
		const bad = Array.from({ length: 12 }, () => line({ eventMessage: "<compose failure [shared UUID]>" })).join("\n");
		const { capture } = await run(bad);
		expect(capture.files).toEqual(["native.log"]);
		expect(capture.problems.join(" ")).toContain("12 of 12");
		expect(capture.problems.join(" ")).toContain("unresolved");
	});

	test("a mostly resolved log has no problem", async () => {
		const { capture } = await run(line({}));
		expect(capture.problems).toEqual([]);
	});

	test("android tail comes from logcat", async () => {
		const { exec } = script([
			["adb -s emulator-5554 shell pidof", ok("42\n")],
			["adb -s emulator-5554 logcat -d -b crash", ok("")],
			["adb -s emulator-5554 logcat", ok("1730832357.456  42  42 E AndroidRuntime: FATAL EXCEPTION\n")],
		]);
		const { fs } = memoryFs();
		const capture = await captureNativeLog(
			android,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/out", sinceMs: SINCE, nowMs: NOW }
		);
		expect(capture.tail).toEqual(["1730832357.456  42  42 E AndroidRuntime: FATAL EXCEPTION"]);
	});
});

describe("enableNativePrivateData", () => {
	test("turns private data on inside the simulator when the status lacks it", async () => {
		const { exec, calls } = script([
			["xcrun simctl spawn U-1 log config --status", ok("System mode = INFO STREAM_LIVE\n")],
			["xcrun simctl spawn U-1 log config --mode", ok("")],
		]);
		expect(await enableNativePrivateData("U-1", exec)).toBeUndefined();
		expect(calls).toEqual([
			"xcrun simctl spawn U-1 log config --status",
			"xcrun simctl spawn U-1 log config --mode private_data:on",
		]);
	});

	test("already on: nothing is changed", async () => {
		const { exec, calls } = script([
			["xcrun simctl spawn U-1 log config --status", ok("System mode = INFO STREAM_LIVE PRIVATE_DATA\n")],
		]);
		expect(await enableNativePrivateData("U-1", exec)).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	test("a failure is a problem string, never a throw", async () => {
		const { exec } = script([
			["xcrun simctl spawn U-1 log config --status", ok("")],
			["xcrun simctl spawn U-1 log config --mode", fail("denied")],
		]);
		expect(await enableNativePrivateData("U-1", exec)).toContain("denied");
		const hung: Exec = () => Promise.reject(new Error("boom"));
		expect(await enableNativePrivateData("U-1", hung)).toContain("boom");
	});
});
