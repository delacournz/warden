import { describe, expect, test } from "bun:test";
import { checkBudgets, describeBreaches, measured, parseBudgets } from "./budgets";
import type { PerfMetrics } from "./perf.types";

const report = (metrics: Partial<PerfMetrics>) => ({ metrics: { topFunctions: [], ...metrics } });

describe("checkBudgets", () => {
	test("lists every metric over its ceiling", () => {
		const breaches = checkBudgets(report({ startupColdMs: 2500, jankPct: 1, topCommitMs: 80 }), {
			startupColdMs: 2000,
			jankPct: 5,
			maxCommitMs: 50,
		});
		expect(breaches).toEqual([
			{ metric: "startupColdMs", value: 2500, budget: 2000 },
			{ metric: "maxCommitMs", value: 80, budget: 50 },
		]);
	});

	test("a value equal to the budget passes", () => {
		expect(checkBudgets(report({ jankPct: 5 }), { jankPct: 5 })).toEqual([]);
	});

	test("a metric the report lacks cannot breach", () => {
		expect(checkBudgets(report({}), { startupColdMs: 1, peakMemoryMb: 1 })).toEqual([]);
	});

	test("overrides replace the config per key", () => {
		const r = report({ jankPct: 8, cpuP95Pct: 90 });
		expect(checkBudgets(r, { jankPct: 5, p95CpuPct: 80 }, { jankPct: 10 })).toEqual([
			{ metric: "p95CpuPct", value: 90, budget: 80 },
		]);
	});

	test("peak memory is the larger of PSS and RSS in MB", () => {
		expect(measured(report({ peakPssKb: 204_800 }), "peakMemoryMb")).toBe(200);
		expect(measured(report({ peakRssKb: 102_400, peakPssKb: 51_200 }), "peakMemoryMb")).toBe(100);
		expect(checkBudgets(report({ peakPssKb: 204_800 }), { peakMemoryMb: 150 })).toHaveLength(1);
	});
});

describe("describeBreaches", () => {
	test("names metric, value, budget and the report", () => {
		const text = describeBreaches([{ metric: "jankPct", value: 12.34, budget: 5 }], "/o/perf/report.json");
		expect(text).toContain("perf_budget: 1 metric over budget");
		expect(text).toContain("jankPct: 12.3 > budget 5");
		expect(text).toContain("report: /o/perf/report.json");
	});
});

describe("parseBudgets", () => {
	test("keeps known numeric keys only", () => {
		expect(parseBudgets('{"jankPct":5,"bogus":1,"startupColdMs":"x"}')).toEqual({ jankPct: 5 });
	});
	test("bad json is empty", () => {
		expect(parseBudgets("{nope")).toEqual({});
		expect(parseBudgets(undefined)).toEqual({});
	});
});
