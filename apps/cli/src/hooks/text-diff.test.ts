import { describe, expect, test } from "bun:test";
import { lineDiff } from "./text-diff";

describe("lineDiff", () => {
	test("identical → empty", () => {
		expect(lineDiff("a\nb\n", "a\nb\n", "f")).toBe("");
	});

	test("shows additions / removals with context and headers", () => {
		const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
		const after = ["1", "2", "3", "4", "X", "5", "6", "7"].join("\n");
		expect(lineDiff(before, after, "f.txt")).toBe(
			["--- f.txt", "+++ f.txt", "@@", "  3", "  4", "+ X", "  5", "  6", "  7", "- 8"].join("\n")
		);
	});

	test("distant changes → separate hunks", () => {
		const before = ["a", "1", "2", "3", "4", "5", "6", "b"].join("\n");
		const after = ["A", "1", "2", "3", "4", "5", "6", "B"].join("\n");
		expect(lineDiff(before, after, "f")).toBe(
			["--- f", "+++ f", "@@", "- a", "+ A", "  1", "  2", "@@", "  5", "  6", "- b", "+ B"].join("\n")
		);
	});

	test("new file → all additions", () => {
		expect(lineDiff("", "a\nb", "new")).toBe(["--- new", "+++ new", "@@", "+ a", "+ b"].join("\n"));
	});
});
