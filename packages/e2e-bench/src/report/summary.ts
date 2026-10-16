import { z } from "zod";
import type { Manifest } from "../results/manifest";
import {
	type BenchRun,
	type Dist,
	type FrameworkResult,
	frameworkIdSchema,
	phaseSchema,
	platformSchema,
	type Series,
} from "../results/schema";
import { perTestMatrix, summaryRows } from "./tables";

/** Bump when the shape changes; the docs page rejects files it does not know. */
export const SUMMARY_VERSION = 1;

const ERROR_MAX = 300;

const distSummarySchema = z.object({
	n: z.number().int().nonnegative(),
	median: z.number(),
	p95: z.number(),
	min: z.number(),
	max: z.number(),
	cvPct: z.number(),
});
export type DistSummary = z.infer<typeof distSummarySchema>;

const seriesSummarySchema = z.object({
	cpuAvgPct: z.number(),
	cpuPeakPct: z.number(),
	rssAvgBytes: z.number(),
	rssPeakBytes: z.number(),
});

const okFrameworkSchema = z.object({
	framework: frameworkIdSchema,
	status: z.literal("ok"),
	version: z.string(),
	suite: distSummarySchema,
	ratio: z.number().optional(),
	fastest: z.boolean(),
	failing: z.boolean(),
	coldRep1Ms: z.number().optional(),
	coldStartMs: z.number().optional(),
	prepareMs: z.number(),
	teardownMs: z.number(),
	overheadMs: z.number(),
	passRate: z.number(),
	flakeRate: z.number(),
	stepLatency: distSummarySchema.optional(),
	resources: z.object({ host: seriesSummarySchema, sim: seriesSummarySchema }),
	residue: z.object({ processes: z.number().int(), driverApps: z.number().int(), paths: z.number().int() }),
	footprint: z.object({
		loc: z.number().int(),
		sourceBytes: z.number().int(),
		depsBytes: z.number().int(),
		binaryBytes: z.number().int(),
	}),
});

const summaryFrameworkSchema = z.discriminatedUnion("status", [
	okFrameworkSchema,
	z.object({
		framework: frameworkIdSchema,
		status: z.literal("failed"),
		version: z.string(),
		phase: phaseSchema,
		error: z.string(),
	}),
	z.object({
		framework: frameworkIdSchema,
		status: z.literal("unsupported"),
		version: z.string().optional(),
		reason: z.string(),
	}),
]);
export type SummaryFramework = z.infer<typeof summaryFrameworkSchema>;

const summaryTestSchema = z.object({
	id: z.string(),
	title: z.string(),
	cells: z.partialRecord(
		frameworkIdSchema,
		z.object({
			medianMs: z.number(),
			ratio: z.number().optional(),
			passRate: z.number(),
			fastest: z.boolean(),
			failing: z.boolean(),
		})
	),
});

/** The slim, versioned JSON the docs comparison page renders (`bench summary`, also `summary.json` next to report.md). */
export const benchSummarySchema = z.object({
	summaryVersion: z.literal(SUMMARY_VERSION),
	runId: z.string(),
	/** `YYYY-MM-DD` of the run start (UTC) */
	date: z.string(),
	startedAt: z.string(),
	platform: platformSchema,
	host: z.object({
		model: z.string(),
		cpu: z.string(),
		cores: z.number().int(),
		memBytes: z.number(),
		macos: z.string(),
		bun: z.string(),
		warden: z.string(),
		loadAvgAtStart: z.number(),
	}),
	device: z.object({ name: z.string().optional(), runtime: z.string().optional() }),
	app: z.object({ bundleId: z.string(), hash: z.string(), sha256: z.string(), bytes: z.number() }),
	options: z.object({ runs: z.number().int(), retries: z.number().int(), caffeinated: z.boolean() }),
	frameworks: z.array(summaryFrameworkSchema),
	tests: z.array(summaryTestSchema),
});
export type BenchSummary = z.infer<typeof benchSummarySchema>;

const SHORT = 12;
const round = (n: number, digits = 0): number => {
	if (!Number.isFinite(n)) return 0;
	const f = 10 ** digits;
	return Math.round(n * f) / f;
};
const roundOpt = (n: number | undefined, digits = 0): number | undefined =>
	n !== undefined && Number.isFinite(n) ? round(n, digits) : undefined;
const opt = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
	value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const distSummary = (d: Dist): DistSummary => ({
	n: d.n,
	median: round(d.median),
	p95: round(d.p95),
	min: round(d.min),
	max: round(d.max),
	cvPct: round(d.cvPct, 1),
});

const seriesSummary = (s: Series) => ({
	cpuAvgPct: round(s.cpuAvgPct, 1),
	cpuPeakPct: round(s.cpuPeakPct, 1),
	rssAvgBytes: round(s.rssAvgBytes),
	rssPeakBytes: round(s.rssPeakBytes),
});

function frameworkSummary(f: FrameworkResult, failing: boolean, fastest: boolean): SummaryFramework {
	if (f.status === "unsupported") {
		return { framework: f.framework, status: "unsupported", ...opt("version", f.version), reason: f.reason };
	}
	if (f.status === "failed") {
		return {
			framework: f.framework,
			status: "failed",
			version: f.version,
			phase: f.phase,
			error: f.error.length > ERROR_MAX ? `${f.error.slice(0, ERROR_MAX)}…` : f.error,
		};
	}
	const s = f.stats;
	return {
		framework: f.framework,
		status: "ok",
		version: f.version,
		suite: distSummary(s.warmSuiteWall),
		...opt("ratio", roundOpt(s.ratioToFastestSuite, 2)),
		fastest,
		failing,
		...opt("coldRep1Ms", roundOpt(s.coldSuiteWallMs)),
		...opt("coldStartMs", roundOpt(s.coldStartMs)),
		prepareMs: round(s.prepareMs),
		teardownMs: round(s.teardownMs),
		overheadMs: round(s.overheadMs),
		passRate: round(s.passRate, 3),
		flakeRate: round(s.flakeRate, 3),
		...(s.stepLatency !== undefined ? { stepLatency: distSummary(s.stepLatency) } : {}),
		resources: { host: seriesSummary(f.resources.host), sim: seriesSummary(f.resources.sim) },
		residue: {
			processes: f.residue.processes.length,
			driverApps: f.residue.driverApps.length,
			paths: f.residue.paths.length,
		},
		footprint: {
			loc: f.footprint.testSourceLoc,
			sourceBytes: f.footprint.testSourceBytes,
			depsBytes: f.footprint.depsBytes,
			binaryBytes: f.footprint.binaryBytes,
		},
	};
}

/** Slims a run to what the docs page shows; no per-rep data, no paths, errors truncated. Deterministic. */
export function benchSummary(run: BenchRun, manifest: Manifest): BenchSummary {
	const rows = summaryRows(run);
	const matrix = perTestMatrix(run, manifest);
	const oks = run.frameworks.flatMap((f) => (f.status === "ok" ? [f] : []));
	return {
		summaryVersion: SUMMARY_VERSION,
		runId: run.id,
		date: run.startedAt.slice(0, 10),
		startedAt: run.startedAt,
		platform: run.device.platform,
		host: {
			model: run.host.model,
			cpu: run.host.cpu,
			cores: run.host.cores,
			memBytes: run.host.memBytes,
			macos: run.host.macos,
			bun: run.host.bun,
			warden: run.host.warden,
			loadAvgAtStart: round(run.host.loadAvgAtStart, 2),
		},
		device: {
			...opt("name", run.device.name),
			...opt("runtime", run.device.runtime),
		},
		app: {
			bundleId: run.app.bundleId,
			hash: run.app.hash.slice(0, SHORT),
			sha256: run.app.sha256.slice(0, SHORT),
			bytes: run.app.bytes,
		},
		options: { runs: run.options.runs, retries: run.options.retries, caffeinated: run.options.caffeinated },
		frameworks: run.frameworks.map((f) => {
			const row = rows.find((r) => r.framework === f.framework);
			return frameworkSummary(f, row?.failing ?? false, row?.fastest ?? false);
		}),
		tests: matrix.rows.map((r) => ({
			id: r.id,
			title: r.title,
			cells: Object.fromEntries(
				oks.flatMap((f) => {
					const cell = r.cells[f.framework];
					const stat = f.stats.perTest[r.id];
					if (cell === undefined || stat === undefined) return [];
					return [
						[
							f.framework,
							{
								medianMs: round(cell.medianMs),
								...opt("ratio", roundOpt(cell.ratio, 2)),
								passRate: round(stat.passRate, 3),
								fastest: cell.fastest,
								failing: cell.failing,
							},
						],
					];
				})
			),
		})),
	};
}
