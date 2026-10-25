import { describe, expect, test } from "bun:test";
import { diffLines, diffReports } from "./diff";
import type { ReportMetrics } from "./report";

const report = (id: string, metrics: Partial<ReportMetrics>) => ({
	sessionId: id,
	metrics: { topFunctions: [], ...metrics },
});

describe("diffReports", () => {
	test("a startup slowdown past the threshold regresses", () => {
		const d = diffReports(report("a", { startupColdMs: 1000 }), report("b", { startupColdMs: 1300 }));
		expect(d.metrics[0]).toMatchObject({ key: "startupColdMs", delta: 300, pct: 30, verdict: "regress" });
		expect(d.regressions).toBe(1);
	});

	test("changes under the threshold or the absolute floor are the same", () => {
		const d = diffReports(
			report("a", { startupColdMs: 1000, jankPct: 0 }),
			report("b", { startupColdMs: 1050, jankPct: 0.3 })
		);
		expect(d.metrics.map((m) => m.verdict)).toEqual(["same", "same"]);
		expect(d.regressions).toBe(0);
	});

	test("fps dropping is the regression, rising is an improvement", () => {
		expect(diffReports(report("a", { fps: 58 }), report("b", { fps: 40 })).metrics[0]?.verdict).toBe("regress");
		expect(diffReports(report("a", { fps: 40 }), report("b", { fps: 58 })).metrics[0]?.verdict).toBe("improve");
	});

	test("a metric only one side has is skipped", () => {
		expect(diffReports(report("a", {}), report("b", { jankPct: 30 })).metrics).toEqual([]);
	});

	test("a custom threshold applies", () => {
		const a = report("a", { peakPssKb: 100_000 });
		const b = report("b", { peakPssKb: 130_000 });
		expect(diffReports(a, b, 50).metrics[0]?.verdict).toBe("same");
		expect(diffReports(a, b, 10).metrics[0]?.verdict).toBe("regress");
	});

	test("functions that grew or appeared are flagged", () => {
		const d = diffReports(
			report("a", { topFunctions: [{ name: "parse", selfPct: 10 }] }),
			report("b", {
				topFunctions: [
					{ name: "parse", selfPct: 25 },
					{ name: "render", selfPct: 9 },
				],
			})
		);
		expect(d.functions.map((f) => [f.name, f.verdict])).toEqual([
			["parse", "regress"],
			["render", "new"],
		]);
		expect(d.regressions).toBe(2);
	});

	test("lines end with the regression count", () => {
		const lines = diffLines(diffReports(report("a", { startupColdMs: 1000 }), report("b", { startupColdMs: 1300 })));
		expect(lines[1]).toContain("REGRESS");
		expect(lines.at(-1)).toBe("1 regression, 0 improvements");
	});
});
