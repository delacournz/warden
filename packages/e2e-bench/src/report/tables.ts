import type { Manifest } from "../results/manifest";
import {
	type BenchRun,
	CANONICAL_IDS,
	type CanonicalId,
	type FrameworkResult,
	type OkFrameworkResult,
	type Residue,
} from "../results/schema";
import { median } from "../results/stats";

type FrameworkKey = FrameworkResult["framework"];

/** One row of the summary table; every metric is undefined unless the framework ran (`ok`). */
export type SummaryRow = {
	framework: FrameworkKey;
	status: FrameworkResult["status"];
	version?: string;
	suiteMedianMs?: number;
	suiteP95Ms?: number;
	ratio?: number;
	coldRep1Ms?: number;
	coldStartMs?: number;
	prepareMs?: number;
	teardownMs?: number;
	overheadMs?: number;
	passRate?: number;
	flakeRate?: number;
	residue?: { processes: number; driverApps: number; paths: number };
	footprint?: { loc: number; depsBytes: number };
	/** host CPU-seconds per rep (median over warm reps of each timed run's window); undefined for older results */
	cpuSecondsPerRep?: number;
	/** true for the framework whose suite ratio is exactly 1 (fastest among fully passing frameworks) */
	fastest: boolean;
	/** true when some test did not pass in every rep, so its timing is not comparable */
	failing: boolean;
};

const isOk = (f: FrameworkResult): f is OkFrameworkResult => f.status === "ok";

const finiteOrUndefined = (n: number | undefined): number | undefined =>
	n !== undefined && Number.isFinite(n) ? n : undefined;

/** Residue as counts (the markdown summary cell); the full lists live in the Residue section. */
export function residueCounts(residue: Residue): { processes: number; driverApps: number; paths: number } {
	return { processes: residue.processes.length, driverApps: residue.driverApps.length, paths: residue.paths.length };
}

/**
 * The headline CPU figure: host CPU-seconds of the timed `run` (`RepResult.resources`), median over the warm
 * reps (all reps when none is warm). Undefined when no rep has a CPU time (results from before 19-6, or a
 * sampler whose ps had no usable `time` column); a rep without one is skipped, never counted as 0.
 */
/** False when the framework has no warm rep (`--runs 1`): `cpuSecondsPerRep` then falls back to all reps. */
export function hasWarmRep(f: OkFrameworkResult): boolean {
	return f.reps.some((r) => !r.cold);
}

export function cpuSecondsPerRep(f: OkFrameworkResult): number | undefined {
	const warm = f.reps.filter((r) => !r.cold);
	const values = (warm.length > 0 ? warm : f.reps).flatMap((r) =>
		r.resources?.cpuSeconds !== undefined ? [r.resources.cpuSeconds] : []
	);
	return values.length > 0 ? median(values) : undefined;
}

function okRow(f: OkFrameworkResult): SummaryRow {
	const s = f.stats;
	const cpu = cpuSecondsPerRep(f);
	return {
		framework: f.framework,
		status: "ok",
		version: f.version,
		suiteMedianMs: finiteOrUndefined(s.warmSuiteWall.median),
		suiteP95Ms: finiteOrUndefined(s.warmSuiteWall.p95),
		ratio: s.ratioToFastestSuite,
		coldRep1Ms: s.coldSuiteWallMs,
		coldStartMs: s.coldStartMs,
		prepareMs: s.prepareMs,
		teardownMs: s.teardownMs,
		overheadMs: finiteOrUndefined(s.overheadMs),
		passRate: s.passRate,
		flakeRate: s.flakeRate,
		residue: residueCounts(f.residue),
		footprint: { loc: f.footprint.testSourceLoc, depsBytes: f.footprint.depsBytes },
		...(cpu !== undefined ? { cpuSecondsPerRep: cpu } : {}),
		fastest: f.stats.ratioToFastestSuite === 1,
		failing: f.stats.passRate < 1,
	};
}

/** Summary rows in run order; `fastest` follows the stats ratio (1), never a failing framework. */
export function summaryRows(run: BenchRun): SummaryRow[] {
	const rows: SummaryRow[] = run.frameworks.map((f) =>
		isOk(f)
			? okRow(f)
			: {
					framework: f.framework,
					status: f.status,
					...(f.version !== undefined ? { version: f.version } : {}),
					fastest: false,
					failing: false,
				}
	);
	return rows;
}

export type MatrixCell = { medianMs: number; ratio?: number; fastest: boolean; failing: boolean };

export type MatrixRow = {
	id: CanonicalId;
	title: string;
	/** keyed by framework; absent for failed / unsupported frameworks or a missing median */
	cells: Partial<Record<FrameworkKey, MatrixCell>>;
};

export type PerTestMatrix = { frameworks: FrameworkKey[]; rows: MatrixRow[] };

/** Per-test warm medians per framework (rows = canonical ids), `fastest` flagged per row. */
export function perTestMatrix(run: BenchRun, manifest: Manifest): PerTestMatrix {
	const frameworks = run.frameworks.map((f) => f.framework);
	const oks = run.frameworks.filter(isOk);
	const rows = CANONICAL_IDS.map((id): MatrixRow => {
		const medians = oks.flatMap((f) => {
			const t = f.stats.perTest[id];
			return t !== undefined && Number.isFinite(t.median) ? [{ f, t }] : [];
		});
		const cells: Partial<Record<FrameworkKey, MatrixCell>> = {};
		for (const { f, t } of medians) {
			cells[f.framework] = {
				medianMs: t.median,
				...(t.ratioToFastest !== undefined ? { ratio: t.ratioToFastest } : {}),
				fastest: t.ratioToFastest === 1,
				failing: t.passRate < 1,
			};
		}
		return { id, title: manifest.tests[id]?.title ?? id, cells };
	});
	return { frameworks, rows };
}

/** What a framework's own trace cannot explain of its test time (warden: `trace.jsonl` steps and spans). */
export type UntracedRow = {
	framework: FrameworkKey;
	/** median over the warm reps of the untraced time summed over the tests that report it */
	perRepMs: number;
	/** that over the same tests' summed duration */
	share: number;
	/** the test with the most untraced time (median over the reps that ran it) */
	worst?: { id: CanonicalId; ms: number };
};

type Measured = { id: CanonicalId; untracedMs?: number; durationMs?: number };

const total = (tests: readonly Measured[], key: "untracedMs" | "durationMs"): number =>
	tests.reduce((acc, t) => acc + (t[key] ?? 0), 0);

/** The test with the most untraced time, each test's time taken as its median over the reps that ran it. */
function worstTest(reps: readonly (readonly Measured[])[]): UntracedRow["worst"] {
	const perTest = new Map<CanonicalId, number[]>();
	for (const tests of reps) {
		for (const t of tests) perTest.set(t.id, [...(perTest.get(t.id) ?? []), t.untracedMs ?? 0]);
	}
	let worst: UntracedRow["worst"];
	for (const [id, values] of perTest) {
		const ms = median(values);
		if (worst === undefined || ms > worst.ms) worst = { id, ms };
	}
	return worst;
}

function untracedRow(f: OkFrameworkResult): UntracedRow | undefined {
	const warm = f.reps.filter((rep) => !rep.cold);
	const reps = (warm.length > 0 ? warm : f.reps).map((rep) => rep.tests.filter((t) => t.untracedMs !== undefined));
	if (reps.every((tests) => tests.length === 0)) return undefined;
	const perRepMs = median(reps.map((tests) => total(tests, "untracedMs")));
	const wallMs = median(reps.map((tests) => total(tests, "durationMs")));
	const worst = worstTest(reps);
	return {
		framework: f.framework,
		perRepMs,
		share: wallMs > 0 ? perRepMs / wallMs : Number.NaN,
		...(worst === undefined ? {} : { worst }),
	};
}

/** One row per framework with `untracedMs` on any test; warm reps only, unless the run has no warm rep. */
export function untracedRows(run: BenchRun): UntracedRow[] {
	return run.frameworks.filter(isOk).flatMap((f) => untracedRow(f) ?? []);
}
