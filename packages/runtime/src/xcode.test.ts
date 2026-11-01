import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "./exec";
import { parseXcodeVersion, readXcode } from "./xcode";

const DEV = "/Applications/Xcode.app/Contents/Developer";

type Reply = ExecResult | undefined;
const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail: ExecResult = { exitCode: 1, stdout: "", stderr: "nope" };

/** Scripted exec: `replies` keyed by the joined argv; unknown commands fail like a missing tool. */
function fakeExec(replies: Record<string, Reply>) {
	const calls: Array<{ cmd: string; env?: Record<string, string | undefined> }> = [];
	const exec: Exec = async (cmd, opts) => {
		const cmdLine = cmd.join(" ");
		calls.push({ cmd: cmdLine, env: opts?.env });
		return replies[cmdLine] ?? fail;
	};
	return { exec, calls };
}

const plist = `${DEV}/../version.plist`.replace(/\/Developer\/\.\./, "");
const plistReplies = {
	"xcode-select -p": ok(`${DEV}\n`),
	[`plutil -extract ProductBuildVersion raw -o - ${plist}`]: ok("27A9275\n"),
	[`plutil -extract CFBundleShortVersionString raw -o - ${plist}`]: ok("27.1\n"),
};

describe("readXcode", () => {
	test("xcode-select path + version.plist", async () => {
		const { exec } = fakeExec(plistReplies);
		expect(await readXcode(exec, {})).toEqual({
			success: true,
			data: { path: DEV, version: "27.1", build: "27A9275", major: 27, source: "xcode-select" },
		});
	});

	test("DEVELOPER_DIR wins and xcode-select is never asked", async () => {
		const beta = "/Applications/Xcode-beta.app/Contents/Developer";
		const betaPlist = "/Applications/Xcode-beta.app/Contents/version.plist";
		const { exec, calls } = fakeExec({
			[`plutil -extract ProductBuildVersion raw -o - ${betaPlist}`]: ok("27B1\n"),
			[`plutil -extract CFBundleShortVersionString raw -o - ${betaPlist}`]: ok("27.2\n"),
		});
		const result = await readXcode(exec, { DEVELOPER_DIR: beta });
		expect(result).toEqual({
			success: true,
			data: { path: beta, version: "27.2", build: "27B1", major: 27, source: "DEVELOPER_DIR" },
		});
		expect(calls.some((c) => c.cmd === "xcode-select -p")).toBe(false);
	});

	test("unreadable plist falls back to xcodebuild -version with DEVELOPER_DIR passed through", async () => {
		const { exec, calls } = fakeExec({
			"xcode-select -p": ok(`${DEV}\n`),
			"xcodebuild -version": ok("Xcode 26.6\nBuild version 17F113\n"),
		});
		const result = await readXcode(exec, { DEVELOPER_DIR: "" });
		expect(result).toEqual({
			success: true,
			data: { path: DEV, version: "26.6", build: "17F113", major: 26, source: "xcode-select" },
		});
		expect(calls.find((c) => c.cmd === "xcodebuild -version")).toBeDefined();
	});

	test("no Xcode selected is an error", async () => {
		const { exec } = fakeExec({});
		expect((await readXcode(exec, {})).success).toBe(false);
	});
});

describe("parseXcodeVersion", () => {
	test("xcodebuild -version output", () => {
		expect(parseXcodeVersion("Xcode 27.1\nBuild version 27A9275\n")).toEqual({
			version: "27.1",
			build: "27A9275",
			major: 27,
		});
		expect(parseXcodeVersion("garbage")).toBeUndefined();
	});
});
