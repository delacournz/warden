import { describe, expect, test } from "bun:test";
import { slowStartupFinding } from "./findings";
import { summarize } from "./stats";

describe("summarize", () => {
	test("odd count", () => {
		expect(summarize([300, 100, 200, 500, 400])).toEqual({
			runs: 5,
			medianMs: 300,
			p90Ms: 500,
			minMs: 100,
			maxMs: 500,
		});
	});
	test("even count averages the middle", () => {
		expect(summarize([100, 200, 300, 400])).toMatchObject({ medianMs: 250, p90Ms: 400 });
	});
	test("p90 of ten is the ninth", () => {
		expect(summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])?.p90Ms).toBe(9);
	});
	test("no samples", () => {
		expect(summarize([])).toBeUndefined();
	});
});

const stats = (medianMs: number) => ({ runs: 5, medianMs, p90Ms: medianMs + 100, minMs: medianMs, maxMs: medianMs });

describe("slowStartupFinding", () => {
	test("fine start: nothing", () => {
		expect(slowStartupFinding("am-start", stats(2000), true)).toBeUndefined();
		expect(slowStartupFinding("am-start", undefined, true)).toBeUndefined();
	});
	test("over 2s warns, over 5s is critical", () => {
		expect(slowStartupFinding("am-start", stats(2500), true)).toMatchObject({
			kind: "startup",
			severity: "warn",
			costMs: 500,
		});
		expect(slowStartupFinding("xctrace", stats(5001), false)).toMatchObject({
			severity: "critical",
			method: "xctrace",
		});
	});
	test("simctl-approx maps to the approx finding method and says it is a lower bound", () => {
		const f = slowStartupFinding("simctl-approx", stats(3000), true);
		expect(f).toMatchObject({ method: "approx", runs: 5 });
		expect(f?.evidence).toContain("lower bound");
	});
});
