import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { FRAMEWORK_IDS } from "../adapters/adapter.types";
import { finalizeFrameworks } from "../orchestrator";
import type { BenchRun, FrameworkResult } from "../results/schema";
import { RESULTS_FILE, readBenchResults, writeBenchResults } from "../results/write";

/** The same framework in `FRAMEWORK_IDS` order, so a merged run reads like one `bench run` with every framework. */
const frameworkRank = (f: FrameworkResult): number => FRAMEWORK_IDS.indexOf(f.framework);

/** An ok framework's cross-framework ratios belong to the run it was computed in; drop them before recomputing. */
function withoutRatios(f: FrameworkResult): FrameworkResult {
	if (f.status !== "ok") return f;
	const { ratioToFastestSuite: _suite, ...stats } = f.stats;
	const perTest = Object.fromEntries(
		Object.entries(stats.perTest).map(([id, t]) => {
			const { ratioToFastest: _ratio, ...rest } = t;
			return [id, rest];
		})
	) as typeof stats.perTest;
	return { ...f, stats: { ...stats, perTest } };
}

/**
 * Merges runs that each measured different frameworks (one EAS worker per framework) into one run.
 * Refuses a framework in two inputs and inputs that differ in platform or app sha256. The merged run takes
 * its host, device, app and options from the input with the first framework in registry order, the earliest
 * `startedAt` and the latest `endedAt`; ratios are recomputed over every ok framework.
 */
export function mergeRuns(runs: readonly BenchRun[], id: string): Result<BenchRun> {
	const first = runs[0];
	if (first === undefined) return err("nothing to merge");
	const seen = new Set<string>();
	for (const run of runs) {
		for (const f of run.frameworks) {
			if (seen.has(f.framework)) return err(`framework ${f.framework} appears in more than one input`);
			seen.add(f.framework);
		}
		if (run.device.platform !== first.device.platform) {
			return err(
				`inputs differ in platform: ${first.device.platform} (${first.id}) vs ${run.device.platform} (${run.id})`
			);
		}
		if (run.app.sha256 !== first.app.sha256) {
			return err(`inputs differ in app sha256: ${first.app.sha256} (${first.id}) vs ${run.app.sha256} (${run.id})`);
		}
	}
	const frameworks = runs.flatMap((r) => r.frameworks).sort((a, b) => frameworkRank(a) - frameworkRank(b));
	const lead = runs.find((r) => r.frameworks.some((f) => f.framework === frameworks[0]?.framework)) ?? first;
	const starts = runs.map((r) => r.startedAt).sort();
	const ends = runs.flatMap((r) => (r.endedAt !== undefined ? [r.endedAt] : [])).sort();
	const endedAt = ends.at(-1);
	return ok({
		schemaVersion: lead.schemaVersion,
		id,
		startedAt: starts[0] ?? lead.startedAt,
		...(endedAt !== undefined ? { endedAt } : {}),
		host: lead.host,
		device: lead.device,
		app: lead.app,
		options: { ...lead.options, frameworks: frameworks.map((f) => f.framework) },
		frameworks: finalizeFrameworks(frameworks.map(withoutRatios)),
	});
}

/** `merged-<date>-<platform>` from the merged run, when `--id` is not given. */
const defaultId = (run: BenchRun): string => `merged-${run.startedAt.slice(0, 10)}-${run.device.platform}`;

/**
 * Reads each input run dir, merges them (see `mergeRuns`) and writes `<outDir>/bench-results.json`. Each input
 * is copied whole into `<outDir>/workers/<framework>/` (a multi-framework input into `a+b`) for provenance.
 * Nothing is written unless every input reads and merges, and an out dir that already holds results is refused.
 */
export function mergeRunDirs(outDir: string, runDirs: readonly string[], opts: { id?: string }): Result<BenchRun> {
	if (existsSync(join(outDir, RESULTS_FILE))) return err(`${outDir} already has ${RESULTS_FILE}`);
	const runs: BenchRun[] = [];
	for (const dir of runDirs) {
		const read = readBenchResults(dir);
		if (!read.success) return err(read.error);
		runs.push(read.data);
	}
	const merged = mergeRuns(runs, opts.id ?? "");
	if (!merged.success) return merged;
	const run = opts.id === undefined ? { ...merged.data, id: defaultId(merged.data) } : merged.data;
	runDirs.forEach((dir, i) => {
		const names = (runs[i]?.frameworks ?? []).map((f) => f.framework).join("+");
		cpSync(dir, join(outDir, "workers", names), { recursive: true });
	});
	writeBenchResults(outDir, run);
	return ok(run);
}
