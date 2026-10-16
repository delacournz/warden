import type { Manifest } from "../results/manifest";
import {
	type BenchRun,
	CANONICAL_IDS,
	type CanonicalId,
	type FrameworkResult,
	type OkFrameworkResult,
	type Residue,
} from "../results/schema";

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

function okRow(f: OkFrameworkResult): SummaryRow {
	const s = f.stats;
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
