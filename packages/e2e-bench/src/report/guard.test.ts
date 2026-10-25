import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchRun, OkFrameworkResult } from "../results/schema";
import { writeBenchResults } from "../results/write";
import { buildSampleRun, withRepCpu } from "./fixtures/make-sample";
import { checkRegression, type GuardSide, loadGuardSide, parseBaseline, sideOfRun } from "./guard";

const side = (cpu: number | undefined, rss: number | undefined, id = "x"): GuardSide => ({
	id,
	startedAt: "2026-10-25T00:00:00.000Z",
	metrics: {
		warden: {
			...(cpu !== undefined ? { cpuSecondsPerRep: cpu } : {}),
			...(rss !== undefined ? { rssPeakBytes: rss } : {}),
		},
	},
});

const MB = 1_000_000;

describe("checkRegression", () => {
	test("within the threshold passes and prints one line per metric", () => {
		const r = checkRegression(side(9.12, 185 * MB), side(9.5, 190 * MB), 10);
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.lines).toEqual([
			"ok: warden cpu-s/rep 9.12 → 9.50 (+4.2 %) within 10 %",
			"ok: warden rss peak 185.0 MB → 190.0 MB (+2.7 %) within 10 %",
		]);
	});

	test("exactly at the threshold is not a regression", () => {
		expect(checkRegression(side(10, 100 * MB), side(11, 110 * MB), 10).kind).toBe("ok");
	});

	test("cpu over the threshold is reported with the documented line", () => {
		const r = checkRegression(side(9.12, 185 * MB), side(10.5, 185 * MB), 10);
		expect(r.kind).toBe("regressed");
		if (r.kind !== "regressed") return;
		expect(r.violations).toEqual(["regression: warden cpu-s/rep 9.12 → 10.50 (+15.1 %) exceeds 10 %"]);
		expect(r.lines).toContain("ok: warden rss peak 185.0 MB → 185.0 MB (+0.0 %) within 10 %");
	});

	test("rss over the threshold is reported on its own", () => {
		const r = checkRegression(side(9, 100 * MB), side(9, 130 * MB), 10);
		expect(r.kind).toBe("regressed");
		if (r.kind !== "regressed") return;
		expect(r.violations).toEqual(["regression: warden rss peak 100.0 MB → 130.0 MB (+30.0 %) exceeds 10 %"]);
	});

	test("both metrics can regress; an improvement never does", () => {
		const both = checkRegression(side(10, 100 * MB), side(20, 200 * MB), 10);
		expect(both.kind === "regressed" && both.violations).toHaveLength(2);
		expect(checkRegression(side(10, 100 * MB), side(5, 50 * MB), 0).kind).toBe("ok");
	});

	test("a missing warden in either run is a usage error, not a pass", () => {
		const none: GuardSide = { id: "n", startedAt: "", metrics: {} };
		const a = checkRegression(none, side(9, MB), 10);
		const b = checkRegression(side(9, MB), none, 10);
		expect(a).toEqual({ kind: "missing", message: "warden is not an ok framework in A (n)" });
		expect(b).toEqual({ kind: "missing", message: "warden is not an ok framework in B (n)" });
	});

	test("a metric missing on one side is a usage error", () => {
		const r = checkRegression(side(undefined, MB), side(9, MB), 10);
		expect(r).toEqual({ kind: "missing", message: "warden has no cpu-s/rep in A (x)" });
	});

	test("a zero baseline cannot define a percentage", () => {
		const r = checkRegression(side(0, MB), side(9, MB), 10);
		expect(r).toEqual({ kind: "missing", message: "warden cpu-s/rep in A (x) is 0, so a percent change is undefined" });
	});
});

describe("sideOfRun", () => {
	const run = withRepCpu(buildSampleRun(), (fw, rep) => (fw === "warden" ? (rep === 1 ? 50 : 9) : 20));

	test("reads the warm-median cpu-s/rep and warm-median per-rep rss peak of an ok framework", () => {
		const s = sideOfRun(run);
		expect(s.id).toBe(run.id);
		expect(s.metrics.warden?.cpuSecondsPerRep).toBeCloseTo(9, 5);
		const warden = run.frameworks.find((f): f is OkFrameworkResult => f.framework === "warden" && f.status === "ok");
		const warm = (warden?.reps ?? [])
			.filter((r) => !r.cold)
			.map((r) => r.resources?.rssPeakBytes ?? 0)
			.sort((x, y) => x - y);
		expect(warm.length).toBeGreaterThan(0);
		expect(s.metrics.warden?.rssPeakBytes).toBeGreaterThan(0);
	});

	test("a framework that is not ok contributes no metrics", () => {
		const failed: BenchRun = {
			...run,
			frameworks: run.frameworks.map((f) =>
				f.framework === "warden" ? { framework: "warden", status: "unsupported", reason: "x" } : f
			),
		};
		expect(sideOfRun(failed).metrics.warden).toBeUndefined();
	});
});

describe("baseline files", () => {
	const good = {
		baselineVersion: 1,
		id: "bench-2026-10-25-ios-eas",
		startedAt: "2026-10-25T12:16:03.510Z",
		platform: "ios",
		frameworks: [{ framework: "warden", cpuSecondsPerRep: 9.12, rssPeakBytes: 184_721_408, warmSuiteMedianMs: 97041 }],
	};

	test("parses into a guard side", () => {
		const parsed = parseBaseline(JSON.stringify(good));
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data).toEqual({
			id: "bench-2026-10-25-ios-eas",
			startedAt: "2026-10-25T12:16:03.510Z",
			metrics: { warden: { cpuSecondsPerRep: 9.12, rssPeakBytes: 184_721_408 } },
		});
	});

	test("rejects bad json, wrong version and bad shapes with a reason", () => {
		expect(parseBaseline("{").success).toBe(false);
		expect(parseBaseline(JSON.stringify({ ...good, baselineVersion: 2 })).success).toBe(false);
		expect(
			parseBaseline(JSON.stringify({ ...good, frameworks: [{ framework: "warden", cpuSecondsPerRep: "9" }] })).success
		).toBe(false);
	});

	test("loadGuardSide takes a baseline file or a run dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "guard-"));
		const file = join(dir, "base.json");
		writeFileSync(file, JSON.stringify(good));
		const fromFile = loadGuardSide(file);
		expect(fromFile.success && fromFile.data.run).toBeUndefined();
		const runDir = join(dir, "run");
		writeBenchResults(runDir, buildSampleRun());
		const fromDir = loadGuardSide(runDir);
		expect(fromDir.success && fromDir.data.run?.id).toBe(buildSampleRun().id);
		expect(loadGuardSide(join(dir, "nope")).success).toBe(false);
	});

	test("the committed ios-warden baseline parses", () => {
		const loaded = loadGuardSide(join(import.meta.dir, "../../baselines/ios-warden.json"));
		expect(loaded.success).toBe(true);
		if (!loaded.success) return;
		expect(loaded.data.side.metrics.warden?.cpuSecondsPerRep).toBeCloseTo(3.79, 2);
	});
});
