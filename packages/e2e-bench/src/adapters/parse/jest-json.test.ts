import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJestJson } from "./jest-json";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "../fixtures/detox", name), "utf8");

describe("parseJestJson", () => {
	test("maps assertion results to native tests with title, status, duration and first failure line", () => {
		const parsed = parseJestJson(fixture("jest-pass.json"));
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.map((t) => [t.nativeName, t.status, t.durationMs])).toEqual([
			["invalid email and short password show field errors", "passed", 4210],
			["a locked account shows the form alert", "passed", 3100],
			["valid credentials land on todos", "failed", 15900],
		]);
		expect(parsed.data[2]?.error).toContain("toHaveText");
		expect(parsed.data[0]?.error).toBeUndefined();
	});

	test("pending / skipped / todo / disabled become skipped", () => {
		const text = JSON.stringify({
			testResults: [
				{
					assertionResults: ["pending", "skipped", "todo", "disabled"].map((status) => ({
						title: status,
						status,
						duration: null,
						failureMessages: [],
					})),
				},
			],
		});
		const parsed = parseJestJson(text);
		expect(parsed.success && parsed.data.every((t) => t.status === "skipped")).toBe(true);
	});

	test("a file that failed before running any test is an error carrying its message", () => {
		const text = JSON.stringify({
			testResults: [
				{
					name: "a.test.js",
					status: "failed",
					message: "Detox can't seem to connect to the test app",
					assertionResults: [],
				},
			],
		});
		const parsed = parseJestJson(text);
		expect(parsed.success).toBe(false);
		if (!parsed.success) expect(parsed.error).toContain("Detox can't seem to connect");
	});

	test("rejects non-JSON and unexpected shapes", () => {
		expect(parseJestJson("nope").success).toBe(false);
		expect(parseJestJson("[]").success).toBe(false);
	});
});
