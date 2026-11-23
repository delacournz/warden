import { describe, expect, test } from "bun:test";
import { adbShellArgv, shellCommand, shellQuote } from "./shell-words";

describe("shellQuote", () => {
	test("leaves a plain word bare", () => {
		expect(shellQuote("com.example.app")).toBe("com.example.app");
		expect(shellQuote("/data/local/tmp/a-1.hprof")).toBe("/data/local/tmp/a-1.hprof");
	});

	test("single-quotes a word holding a space, `;`, `$` or `?`", () => {
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("a;b")).toBe("'a;b'");
		expect(shellQuote("Main$Inner")).toBe("'Main$Inner'");
		expect(shellQuote("exp://127.0.0.1:8081/?a=1&b=2")).toBe("'exp://127.0.0.1:8081/?a=1&b=2'");
	});

	test("keeps a single quote inside a quoted word", () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	test("an empty word stays a word", () => {
		expect(shellQuote("")).toBe("''");
	});
});

test("shellCommand joins quoted words into one line", () => {
	expect(shellCommand(["settings", "put", "secure", "k", "a b"])).toBe("settings put secure k 'a b'");
});

describe("adbShellArgv", () => {
	test("plain words give the same argv as before", () => {
		expect(adbShellArgv(["adb", "-s", "emulator-5554"], ["am", "force-stop", "com.example.app"])).toEqual([
			"adb",
			"-s",
			"emulator-5554",
			"shell",
			"am",
			"force-stop",
			"com.example.app",
		]);
	});

	test("every word reaches the device shell as one word", () => {
		expect(adbShellArgv(["adb"], ["settings", "put", "secure", "k", "a b;c", ""])).toEqual([
			"adb",
			"shell",
			"settings",
			"put",
			"secure",
			"k",
			"'a b;c'",
			"''",
		]);
	});
});
