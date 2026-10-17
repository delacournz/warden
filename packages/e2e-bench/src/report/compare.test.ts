import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadManifest } from "../results/manifest";
import type { BenchRun, FrameworkResult } from "../results/schema";
import { compareRuns, delta, renderCompareMarkdown } from "./compare";
import { buildSampleRun, withRepCpu } from "./fixtures/make-sample";
import { goldenText } from "./golden";

const manifest = loadManifest(join(import.meta.dir, "../.."));
const a = buildSampleRun();

/** B = A with every ok framework 10% slower; detox dropped, tester-army now unsupported. */
function slower(run: BenchRun): BenchRun {
	const b = structuredClone(run);
	b.id = "bench-2026-10-17-ios-d4e5f6";
	b.startedAt = "2026-10-17T01:00:00.000Z";
	const frameworks: FrameworkResult[] = [];
	for (const f of b.frameworks) {
		if (f.framework === "detox") continue;
		if (f.status === "ok") {
			f.stats.warmSuiteWall.median = Math.round(f.stats.warmSuiteWall.median * 1.1 * 10) / 10;
			for (const t of Object.values(f.stats.perTest)) t.median = Math.round(t.median * 1.1 * 10) / 10;
		}
		frameworks.push(
			f.framework === "tester-army" ? { framework: "tester-army", status: "unsupported", reason: "dropped" } : f
		);
	}
	b.frameworks = frameworks;
	return b;
}
const b = slower(a);

describe("compareRuns", () => {
	const result = compareRuns(a, b);
	test("delta math", () => {
		expect(delta(1000, 1100)).toEqual({ aMs: 1000, bMs: 1100, deltaMs: 100, deltaPct: 10 });
		expect(delta(0, 5)).toBeUndefined();
		expect(delta(Number.NaN, 5)).toBeUndefined();
	});
	test("suite and per-test deltas are about +10%", () => {
		const warden = result.frameworks.find((f) => f.framework === "warden");
		expect(warden?.suite?.deltaPct).toBeCloseTo(10, 0);
		expect(warden?.tests).toHaveLength(8);
	});
	test("status changes and one-sided frameworks", () => {
		expect(result.statusChanges).toEqual([{ framework: "tester-army", from: "failed", to: "unsupported" }]);
		expect(result.onlyInA).toEqual(["detox"]);
		expect(result.onlyInB).toEqual([]);
	});
});

describe("renderCompareMarkdown", () => {
	const md = renderCompareMarkdown(compareRuns(a, b), manifest);
	test("matches the golden file", () => {
		expect(md).toBe(goldenText(join(import.meta.dir, "fixtures/compare.golden.md"), md));
	});
	test("identical runs have no changes", () => {
		const same = renderCompareMarkdown(compareRuns(a, a), manifest);
		expect(same).toContain("| 0 ms | 0.0% |");
		expect(same).toContain("## Status changes\n\nNone.");
	});
});

describe("compare CPU-seconds per rep (19-6)", () => {
	test("a delta per framework both runs measured, and a section only then", () => {
		const ca = withRepCpu(a, () => 4);
		const cb = withRepCpu(a, () => 3);
		const result = compareRuns(ca, cb);
		const warden = result.frameworks.find((f) => f.framework === "warden");
		expect(warden?.cpuSecondsPerRep).toEqual({ a: 4, b: 3, delta: -1, deltaPct: -25 });
		const md = renderCompareMarkdown(result, manifest);
		expect(md).toContain("## Host CPU-seconds per rep (warm)");
		expect(md).toContain("| warden | 4.00 s | 3.00 s | -1.00 s | -25.0% |");
		expect(compareRuns(a, a).frameworks.every((f) => f.cpuSecondsPerRep === undefined)).toBe(true);
		expect(renderCompareMarkdown(compareRuns(a, a), manifest)).not.toContain("CPU-seconds");
	});

	test("a run without warm reps (--runs 1) is labelled all reps, not passed off as warm (bench-fidelity-R6)", () => {
		const coldOnly = (run: BenchRun): BenchRun => {
			const out = structuredClone(run);
			for (const f of out.frameworks) if (f.status === "ok") f.reps = f.reps.filter((r) => r.cold);
			return out;
		};
		const result = compareRuns(
			coldOnly(withRepCpu(a, () => 4)),
			withRepCpu(a, () => 3)
		);
		const warden = result.frameworks.find((f) => f.framework === "warden");
		expect(warden?.cpuSecondsPerRep).toEqual({ a: 4, b: 3, delta: -1, deltaPct: -25, allReps: true });
		const md = renderCompareMarkdown(result, manifest);
		expect(md).toContain("| warden (all reps) | 4.00 s | 3.00 s | -1.00 s | -25.0% |");
		expect(md).toContain("no warm rep");
		const warm = renderCompareMarkdown(
			compareRuns(
				withRepCpu(a, () => 4),
				withRepCpu(a, () => 3)
			),
			manifest
		);
		expect(warm).not.toContain("(all reps)");
	});
});
