import { describe, expect, test } from "bun:test";
import { decodeSamples, encodeSample, type MetricSample, memoryGrowthFinding, stat, summarize } from "./series";

const sample = (atMs: number, rssKb: number, extra: Partial<MetricSample> = {}): MetricSample => ({
	wallMs: 1_000_000 + atMs,
	atMs,
	pid: 7,
	rssKb,
	...extra,
});

const climbing = (n: number, kbPerSample: number, pss = true): MetricSample[] =>
	Array.from({ length: n }, (_, i) =>
		sample(i * 1000, 100_000 + i * kbPerSample, pss ? { pssKb: 80_000 + i * kbPerSample } : {})
	);

describe("stat", () => {
	test("min/avg/p95 (nearest rank)/max", () => {
		const values = Array.from({ length: 20 }, (_, i) => i + 1);
		expect(stat(values)).toEqual({ min: 1, avg: 10.5, p95: 19, max: 20 });
	});
	test("one value", () => expect(stat([4])).toEqual({ min: 4, avg: 4, p95: 4, max: 4 }));
	test("none", () => expect(stat([])).toBeUndefined());
});

describe("samples.jsonl", () => {
	test("encode then decode round-trips; torn and foreign lines are skipped", () => {
		const a = sample(0, 1000);
		const b = sample(1000, 1100, { cpuPct: 12.5, pssKb: 900, fps: 59.8 });
		const text = `${encodeSample(a)}${encodeSample(b)}{"wallMs":1,"atM\nnot json\n{"x":1}\n`;
		expect(decodeSamples(text)).toEqual([a, b]);
	});
});

describe("summarize", () => {
	test("cpu ignores the baseline sample that has none; fps/pss only when present", () => {
		const s = summarize([sample(0, 1000), sample(1000, 1200, { cpuPct: 10 }), sample(2000, 1100, { cpuPct: 30 })]);
		expect(s?.count).toBe(3);
		expect(s?.durationMs).toBe(2000);
		expect(s?.cpuPct).toEqual({ min: 10, avg: 20, p95: 30, max: 30 });
		expect(s?.rssKb.max).toBe(1200);
		expect(s?.pssKb).toBeUndefined();
		expect(s?.fps).toBeUndefined();
	});

	test("growth uses PSS when every sample has it, else RSS", () => {
		expect(summarize(climbing(8, 500))?.growth?.metric).toBe("pss");
		expect(summarize(climbing(8, 500, false))?.growth?.metric).toBe("rss");
	});

	test("slope is KB per second over the series", () => {
		const g = summarize(climbing(8, 500))?.growth;
		expect(g?.slopeKbPerSec).toBeCloseTo(500, 5);
		expect(g?.risingShare).toBe(1);
	});

	test("empty: undefined", () => expect(summarize([])).toBeUndefined());
});

describe("memoryGrowthFinding", () => {
	test("a steady climb is a memory-growth finding with the slope", () => {
		const summary = summarize(climbing(10, 300));
		const finding = summary === undefined ? undefined : memoryGrowthFinding(summary);
		expect(finding).toMatchObject({ kind: "memory-growth", severity: "warn", slopeKbPerSec: 300 });
		expect(finding?.next).toContain("warden perf memory --snapshot");
	});

	test("over 1 MB/s is critical", () => {
		const summary = summarize(climbing(10, 2000));
		expect(summary && memoryGrowthFinding(summary)?.severity).toBe("critical");
	});

	test("a sawtooth (GC) series is not a leak", () => {
		const saw = Array.from({ length: 12 }, (_, i) => sample(i * 1000, 100_000 + (i % 2 === 0 ? 0 : 6000) + i * 120));
		const summary = summarize(saw);
		expect(summary && memoryGrowthFinding(summary)).toBeUndefined();
	});

	test("too few samples, too short a span, or too little growth say nothing", () => {
		for (const series of [
			climbing(4, 500),
			climbing(10, 20),
			climbing(6, 200).map((s) => ({ ...s, atMs: s.atMs / 10 })),
		]) {
			const summary = summarize(series);
			expect(summary && memoryGrowthFinding(summary)).toBeUndefined();
		}
	});

	test("flat memory: no finding", () => {
		const summary = summarize(climbing(10, 0));
		expect(summary && memoryGrowthFinding(summary)).toBeUndefined();
	});
});
