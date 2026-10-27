import { describe, expect, test } from "bun:test";
import type { ConsoleLine } from "@delacour/warden-e2e/devtools/devtools.types";
import { isAppException } from "./exceptions";

const line = (over: Partial<ConsoleLine>): ConsoleLine => ({
	ts: 1,
	level: "log",
	kind: "console",
	text: "x",
	...over,
});
const at = (fn: string) => ({ file: "http://h/index.bundle", line: 1, col: 1, fn });

describe("isAppException", () => {
	test("a CDP exception, and an error React Native reported through ExceptionsManager", () => {
		expect(isAppException(line({ kind: "exception", level: "error" }))).toBe(true);
		expect(isAppException(line({ level: "error", stack: [at("methodName"), at("reportException")] }))).toBe(true);
		expect(isAppException(line({ level: "error", stack: [at("handleException")] }))).toBe(true);
	});

	test("a plain console.error, or a reporter frame on a non-error line, is not", () => {
		expect(isAppException(line({ level: "error" }))).toBe(false);
		expect(isAppException(line({ level: "error", stack: [at("onPress")] }))).toBe(false);
		expect(isAppException(line({ level: "warn", stack: [at("reportException")] }))).toBe(false);
	});
});
