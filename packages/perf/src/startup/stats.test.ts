import { describe, expect, test } from "bun:test";
import { startupFindings } from "./findings";
import { startupStatistics } from "./stats";

describe("summarize", () => {
	test("odd count", () => {
		expect(startupStatistics.summarize([300, 100, 200, 500, 400])).toEqual({
			runs: 5,
			medianMs: 300,
			p90Ms: 500,
			minMs: 100,
			maxMs: 500,
		});
	});
	test("even count averages the middle", () => {
		expect(startupStatistics.summarize([100, 200, 300, 400])).toMatchObject({ medianMs: 250, p90Ms: 400 });
	});
	test("p90 of ten is the ninth", () => {
		expect(startupStatistics.summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])?.p90Ms).toBe(9);
	});
	test("no samples", () => {
		expect(startupStatistics.summarize([])).toBeUndefined();
	});
});

const stats = (medianMs: number) => ({ runs: 5, medianMs, p90Ms: medianMs + 100, minMs: medianMs, maxMs: medianMs });

describe("slowStartupFinding", () => {
	test("fine start: nothing", () => {
		expect(startupFindings.slowStartupFinding("am-start", stats(2000), true)).toBeUndefined();
		expect(startupFindings.slowStartupFinding("am-start", undefined, true)).toBeUndefined();
	});
	test("over 2s warns, over 5s is critical", () => {
		expect(startupFindings.slowStartupFinding("am-start", stats(2500), true)).toMatchObject({
			kind: "startup",
			severity: "warn",
			costMs: 500,
		});
		expect(startupFindings.slowStartupFinding("xctrace", stats(5001), false)).toMatchObject({
			severity: "critical",
			method: "xctrace",
		});
	});
	test("simctl-approx maps to the approx finding method and says it is a lower bound", () => {
		const f = startupFindings.slowStartupFinding("simctl-approx", stats(3000), true);
		expect(f).toMatchObject({ method: "approx", runs: 5 });
		expect(f?.evidence).toContain("lower bound");
	});
});
