import { describe, expect, test } from "bun:test";
import { isSummary } from "./bench-parse";
import { type ProcessInput, shapeScope } from "./bench-processes";

const row = (name: string, cpuSeconds: number, scope: "host" | "sim" = "host"): ProcessInput => ({
	name,
	scope,
	cpuSeconds,
	rssAvgBytes: 1,
	shareOfScopePct: 0,
});

describe("isSummary", () => {
	test("accepts versions 1 and 2, rejects others", () => {
		expect(isSummary({ summaryVersion: 1, frameworks: [] })).toBe(true);
		expect(isSummary({ summaryVersion: 2, frameworks: [] })).toBe(true);
		expect(isSummary({ summaryVersion: 3, frameworks: [] })).toBe(false);
		expect(isSummary({ summaryVersion: 2 })).toBe(false);
		expect(isSummary(null)).toBe(false);
	});
});

describe("shapeScope", () => {
	test("undefined when no framework has rows for the scope", () => {
		expect(shapeScope("host", [{ framework: "a", rows: undefined }])).toBeUndefined();
		expect(shapeScope("sim", [{ framework: "a", rows: [row("x", 1)] }])).toBeUndefined();
	});

	test("top 6 names get slots, the rest fold into other", () => {
		const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
		const rows = names.map((n, i) => row(n, 10 - i));
		const chart = shapeScope("host", [{ framework: "w", rows }]);
		expect(chart?.legend).toEqual(["a", "b", "c", "d", "e", "f"]);
		const bar = chart?.bars[0];
		expect(bar?.segments.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, "other"]);
		expect(bar?.segments.at(-1)?.cpuSeconds).toBe(4 + 3);
		expect(bar?.total).toBe(10 + 9 + 8 + 7 + 6 + 5 + 7);
	});

	test("a name keeps its slot across frameworks and an existing other row folds in", () => {
		const chart = shapeScope("host", [
			{ framework: "w", rows: [row("bun", 5), row("node", 1), row("other", 2)] },
			{ framework: "m", rows: [row("node", 9), row("bun", 1)] },
		]);
		expect(chart?.legend).toEqual(["node", "bun"]);
		expect(chart?.bars[0]?.segments).toEqual([
			{ name: "node", cpuSeconds: 1, slot: 0 },
			{ name: "bun", cpuSeconds: 5, slot: 1 },
			{ name: "other", cpuSeconds: 2, slot: "other" },
		]);
		expect(chart?.bars[1]?.segments.map((s) => s.slot)).toEqual([0, 1]);
		expect(chart?.max).toBe(10);
	});
});
