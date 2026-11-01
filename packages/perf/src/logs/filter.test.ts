import { describe, expect, test } from "bun:test";
import { logMatcher } from "./filter";
import type { LogEntry } from "./levels";

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
	ts: "10-24 10:00:01.123",
	tsMs: Date.UTC(2026, 9, 24, 10, 0, 1, 123),
	pid: 4321,
	tid: 4321,
	level: "I",
	tag: "ReactNativeJS",
	msg: "Running main",
	...over,
});

describe("matchesFilter", () => {
	test("min level", () => {
		expect(logMatcher.matchesFilter(entry({ level: "D" }), { minLevel: "W" })).toBe(false);
		expect(logMatcher.matchesFilter(entry({ level: "E" }), { minLevel: "W" })).toBe(true);
	});

	test("since", () => {
		const e = entry();
		expect(logMatcher.matchesFilter(e, { sinceMs: e.tsMs + 1 })).toBe(false);
		expect(logMatcher.matchesFilter(e, { sinceMs: e.tsMs })).toBe(true);
	});

	test("grep matches tag or message, case-insensitively", () => {
		const g = logMatcher.compileGrep("reactnative");
		if (!g.success) throw new Error("grep");
		expect(logMatcher.matchesFilter(entry(), { grep: g.data })).toBe(true);
		expect(logMatcher.matchesFilter(entry({ tag: "OkHttp", msg: "GET /" }), { grep: g.data })).toBe(false);
	});

	test("bad pattern is an error, not a throw", () => {
		expect(logMatcher.compileGrep("(").success).toBe(false);
	});
});

test("formatEntry", () => {
	expect(logMatcher.formatEntry(entry())).toBe("10-24 10:00:01.123  4321 I ReactNativeJS: Running main");
});
