import { describe, expect, test } from "bun:test";
import { perfDuration } from "./duration";

describe("parseDuration", () => {
	test.each([
		["500ms", 500],
		["1s", 1000],
		["1.5s", 1500],
		["2m", 120_000],
		["3", 3000],
		[" 10s ", 10_000],
	])("%s -> %d", (text, ms) => expect(perfDuration.parseDuration(text)).toBe(ms));

	test.each(["", "0", "0s", "-1s", "abc", "1h", "1 s"])("rejects %p", (text) =>
		expect(perfDuration.parseDuration(text)).toBeUndefined()
	);
});
