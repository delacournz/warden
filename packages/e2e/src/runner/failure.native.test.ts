import { describe, expect, test } from "bun:test";
import type { Exec } from "@delacour/warden-core/exec";
import type { NativeFs } from "../devtools/native-log";
import { captureNativeArtifacts, nativeTarget } from "./failure";

const fs: NativeFs = { listReports: () => [], copy: () => {}, write: () => {} };
const exec: Exec = async (cmd) =>
	cmd.includes("get_app_container") || cmd.includes("plutil")
		? { exitCode: 0, stdout: "App\n", stderr: "" }
		: { exitCode: 0, stdout: "line\n", stderr: "" };

describe("nativeTarget", () => {
	test("ios udid / android serial", () => {
		expect(nativeTarget({ platform: "ios", udid: "U", bundleId: "b.c" })).toEqual({
			platform: "ios",
			udid: "U",
			bundleId: "b.c",
		});
		expect(nativeTarget({ platform: "android", udid: "emulator-5554", bundleId: "b.c" })).toEqual({
			platform: "android",
			serial: "emulator-5554",
			pkg: "b.c",
		});
	});
});

describe("captureNativeArtifacts", () => {
	const target = nativeTarget({ platform: "ios", udid: "U", bundleId: "b.c" });
	test("lists native.log when written", async () => {
		const capture = await captureNativeArtifacts(
			target,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/o", sinceMs: Date.now() }
		);
		expect(capture.files).toEqual(["native.log"]);
	});
	test("passes the tail of the readable lines through", async () => {
		const withTail: Exec = async (cmd) =>
			cmd.includes("get_app_container") || cmd.includes("plutil")
				? { exitCode: 0, stdout: "App\n", stderr: "" }
				: {
						exitCode: 0,
						stdout: `${JSON.stringify({ eventType: "logEvent", messageType: "Error", timestamp: "2026-11-05 18:45:56.413920+0000", eventMessage: "SecError" })}\n`,
						stderr: "",
					};
		const capture = await captureNativeArtifacts(
			target,
			{ exec: withTail, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/o", sinceMs: Date.now() }
		);
		expect(capture.tail).toEqual(["18:45:56.413 error SecError"]);
	});
	test("spent budget skips with a problem", async () => {
		const capture = await captureNativeArtifacts(
			target,
			{ exec, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/o", sinceMs: 0 },
			10_000,
			() => 0
		);
		expect(capture.files).toEqual([]);
		expect(capture.problems[0]).toContain("native log");
	});
	test("a hung exec is cut at the timeout", async () => {
		const hung: Exec = () => new Promise(() => {});
		const capture = await captureNativeArtifacts(
			target,
			{ exec: hung, adb: "adb", fs, reportsDir: "/r" },
			{ dir: "/o", sinceMs: 0 },
			20
		);
		expect(capture.files).toEqual([]);
		expect(capture.problems[0]).toContain("timed out");
	});
});
