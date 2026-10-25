import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReports } from "../orchestrator";
import { loadManifest } from "../results/manifest";
import { type BenchRun, benchRunSchema, type OkFrameworkResult, repResourcesSchema } from "../results/schema";
import { readBenchResults, writeBenchResults } from "../results/write";
import { compareRuns, renderCompareMarkdown } from "./compare";
import { buildSampleRun, withRepCpu } from "./fixtures/make-sample";
import { goldenText } from "./golden";
import { renderHtml } from "./html";
import { renderMarkdown } from "./markdown";
import { benchSummary, benchSummarySchema } from "./summary";
import { processesPerRep } from "./tables";

const manifest = loadManifest(join(import.meta.dir, "../.."));
const base = buildSampleRun();
const withProcesses = withRepCpu(base, (_f, rep) => rep);

const ok = (run: BenchRun, framework: string): OkFrameworkResult => {
	const f = run.frameworks.find((x) => x.framework === framework);
	if (f?.status !== "ok") throw new Error(`no ok ${framework}`);
	return f;
};

describe("results schema with processes", () => {
	test("a run with per-process rows round-trips; one without still parses", () => {
		expect(benchRunSchema.parse(JSON.parse(JSON.stringify(withProcesses)))).toEqual(
			JSON.parse(JSON.stringify(withProcesses))
		);
		expect(benchRunSchema.safeParse(JSON.parse(JSON.stringify(base))).success).toBe(true);
	});
	test("rep resources without processes parse, a malformed row does not", () => {
		const rep = ok(withProcesses, "warden").reps[0]?.resources;
		expect(repResourcesSchema.safeParse({ ...rep, processes: undefined }).success).toBe(true);
		expect(repResourcesSchema.safeParse({ ...rep, processes: [{ name: "x" }] }).success).toBe(false);
	});
});

describe("processesPerRep", () => {
	test("picks the warm rep whose CPU-seconds is the lower median", () => {
		const f = ok(withProcesses, "warden");
		// reps 1 (cold), 2, 3: warm cpu 2 and 3, the lower median is rep 2
		const rows = processesPerRep(f);
		expect(rows).toEqual(f.reps[1]?.resources?.processes);
	});
	test("undefined for a run without processes", () => {
		expect(processesPerRep(ok(base, "warden"))).toBeUndefined();
	});
});

describe("Where the CPU goes", () => {
	const md = renderMarkdown(withProcesses, manifest);
	test("markdown matches the golden file", () => {
		expect(md).toBe(goldenText(join(import.meta.dir, "fixtures/report.processes.golden.md"), md));
	});
	test("one table per framework with the process columns", () => {
		expect(md).toContain("## Where the CPU goes");
		expect(md).toContain("| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |");
		expect(md).toMatch(
			/\| SimulatorFrameworkBridge-iOS serve \| host \| [\d.]+ s \| 16\.0% \| 22\.0 MB \| 24\.0 MB \| 11 \|/
		);
		expect(md).toContain("### warden");
		expect(md).toContain("### argent");
	});
	test("the CPU-seconds headline stays the first resource column", () => {
		expect(md).toContain("| Framework | Scope | CPU-s / rep |");
	});
	test("html has the section and leads the resources table with CPU-s / rep", () => {
		const html = renderHtml(withProcesses, manifest);
		expect(html).toContain(`<section id="processes"><h2>Where the CPU goes</h2>`);
		expect(html).toContain('<th scope="col">CPU-s / rep</th>');
		expect(html).toContain("decaying average");
		expect(html).toContain("<td>backboardd</td>");
	});
	test("a run without processes has no such section in either report", () => {
		expect(renderMarkdown(base, manifest)).not.toContain("Where the CPU goes");
		const html = renderHtml(base, manifest);
		expect(html).not.toContain("Where the CPU goes");
		expect(html).not.toContain("CPU-s / rep");
	});
});

describe("old run dir", () => {
	test("bench report on a results file with no processes still renders", () => {
		const dir = mkdtempSync(join(tmpdir(), "bench-old-"));
		try {
			writeBenchResults(dir, base);
			const read = readBenchResults(dir);
			expect(read.success).toBe(true);
			if (!read.success) return;
			writeReports(dir, read.data, { manifest, renderHtml });
			const md = readFileSync(join(dir, "report.md"), "utf8");
			expect(md).toContain("## Resources");
			expect(md).not.toContain("Where the CPU goes");
			const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
			expect(benchSummarySchema.safeParse(summary).success).toBe(true);
			for (const f of summary.frameworks) expect(f.processes).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("summary processes", () => {
	const summary = benchSummary(withProcesses, manifest);
	test("version 2 carries the warm-median rep's rows per ok framework", () => {
		expect(summary.summaryVersion).toBe(2);
		const warden = summary.frameworks.find((f) => f.framework === "warden");
		expect(warden?.status === "ok" && warden.processes?.[0]).toEqual({
			name: "bun test",
			scope: "host",
			cpuSeconds: 0.92,
			rssAvgBytes: 92 * 1024 ** 2,
			rssPeakBytes: 101 * 1024 ** 2,
			spawnCount: 1,
			shareOfScopePct: 46,
		});
		expect(benchSummarySchema.safeParse(JSON.parse(JSON.stringify(summary))).success).toBe(true);
	});
	test("a version 1 file (no processes) still parses", () => {
		const v1 = JSON.parse(JSON.stringify(benchSummary(base, manifest)));
		v1.summaryVersion = 1;
		expect(benchSummarySchema.safeParse(v1).success).toBe(true);
	});
});

/** B = A with `warden-simd` gone and `bun test` at half the CPU. */
function optimised(run: BenchRun): BenchRun {
	const b = structuredClone(run);
	const rows = b.frameworks
		.flatMap((f) => (f.status === "ok" ? f.reps : []))
		.flatMap((r) => r.resources?.processes ?? []);
	for (const p of rows) {
		if (p.name === "warden-simd") p.cpuSeconds = 0;
		if (p.name === "bun test") p.cpuSeconds *= 0.5;
	}
	return b;
}

describe("compare processes", () => {
	const b = optimised(withProcesses);
	test("diffs the top rows by scope and name", () => {
		const result = compareRuns(withProcesses, b);
		const warden = result.frameworks.find((f) => f.framework === "warden");
		const bun = warden?.processes?.find((p) => p.name === "bun test" && p.scope === "host");
		expect(bun?.deltaCpuSeconds).toBeCloseTo(-0.46, 6);
		const simd = warden?.processes?.find((p) => p.name === "warden-simd");
		expect(simd?.bCpuSeconds).toBe(0);
		expect(warden?.processes?.some((p) => p.scope === "sim")).toBe(true);
	});
	test("markdown matches the golden file and omits the section for old runs", () => {
		const md = renderCompareMarkdown(compareRuns(withProcesses, b), manifest);
		expect(md).toBe(goldenText(join(import.meta.dir, "fixtures/compare.processes.golden.md"), md));
		expect(md).toContain("## Where the CPU goes: warden");
		expect(renderCompareMarkdown(compareRuns(base, base), manifest)).not.toContain("Where the CPU goes");
	});
});
