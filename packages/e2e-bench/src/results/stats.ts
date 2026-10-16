import {
	CANONICAL_IDS,
	type CanonicalId,
	type Dist,
	type FrameworkStats,
	type PerTestStats,
	type RepResult,
	type TestStatus,
} from "./schema";

/** Nearest-rank percentile of an ascending list (`q` in 0..1); NaN for an empty list. */
export function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
	return sorted[rank - 1] ?? Number.NaN;
}

export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) return Number.NaN;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? (sorted[mid] ?? Number.NaN) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Population standard deviation. */
export function stddev(values: readonly number[]): number {
	if (values.length === 0) return Number.NaN;
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
	return Math.sqrt(variance);
}

/** The distribution summary of `values` (ms). All NaN when empty, with `n: 0`. */
export function dist(values: readonly number[]): Dist {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	if (n === 0) {
		return {
			n: 0,
			median: Number.NaN,
			p95: Number.NaN,
			min: Number.NaN,
			max: Number.NaN,
			stddev: Number.NaN,
			cvPct: Number.NaN,
		};
	}
	const mean = sorted.reduce((a, b) => a + b, 0) / n;
	const sd = stddev(sorted);
	return {
		n,
		median: round1(median(sorted)),
		p95: round1(percentile(sorted, 0.95)),
		min: round1(sorted[0] ?? Number.NaN),
		max: round1(sorted[n - 1] ?? Number.NaN),
		stddev: round1(sd),
		cvPct: mean === 0 ? 0 : round1((sd / mean) * 100),
	};
}

/** `a / b` rounded to 2 decimals; undefined when either side is not a positive finite number. */
export function ratio(a: number, b: number): number | undefined {
	if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return undefined;
	return Math.round((a / b) * 100) / 100;
}

const warmReps = (reps: readonly RepResult[]): RepResult[] => reps.filter((r) => !r.cold);

/** The warm reps, or every rep when there is no warm one (a `--runs 1` run). */
export function repsForMedians(reps: readonly RepResult[]): RepResult[] {
	const warm = warmReps(reps);
	return warm.length > 0 ? warm : [...reps];
}

function testIn(rep: RepResult, id: CanonicalId) {
	return rep.tests.find((t) => t.id === id);
}

/** Durations of `id` across `reps` where it ran (any status with a duration). */
function durationsOf(reps: readonly RepResult[], id: CanonicalId): number[] {
	return reps.flatMap((rep) => {
		const t = testIn(rep, id);
		return t?.durationMs !== undefined ? [t.durationMs] : [];
	});
}

/** Fraction of reps where the majority status is not the rep's status. */
export function flakeRate(statuses: readonly TestStatus[]): number {
	if (statuses.length === 0) return 0;
	const counts = new Map<TestStatus, number>();
	for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
	const majority = Math.max(...counts.values());
	return Math.round(((statuses.length - majority) / statuses.length) * 1000) / 1000;
}

export function passRate(statuses: readonly TestStatus[]): number {
	if (statuses.length === 0) return 0;
	return Math.round((statuses.filter((s) => s === "passed").length / statuses.length) * 1000) / 1000;
}

/** Σ durations of the tests of a rep (missing tests count 0). */
export function sumTests(rep: RepResult): number {
	return rep.tests.reduce((acc, t) => acc + (t.durationMs ?? 0), 0);
}

export type FrameworkStatsInput = {
	reps: readonly RepResult[];
	prepareMs: number;
	teardownMs: number;
};

/** Per-framework stats from its reps (before cross-framework ratios, see `withRatios`). */
export function frameworkStats(input: FrameworkStatsInput): FrameworkStats {
	const all = input.reps;
	const warm = repsForMedians(all);
	const cold = all.find((r) => r.cold);
	const warmWalls = warm.map((r) => r.wallMs);
	const warmSuiteWall = dist(warmWalls);
	const perTest: Record<string, PerTestStats> = {};
	for (const id of CANONICAL_IDS) {
		const statuses = all.map((rep) => testIn(rep, id)?.status ?? "missing");
		perTest[id] = {
			...dist(durationsOf(warm, id)),
			passRate: passRate(statuses),
			flakeRate: flakeRate(statuses),
		};
	}
	const overheads = warm.map((rep) => rep.wallMs - sumTests(rep));
	const steps = warm.flatMap((rep) => rep.tests.flatMap((t) => (t.steps ?? []).map((s) => s.ms)));
	const allStatuses = all.flatMap((rep) => CANONICAL_IDS.map((id) => testIn(rep, id)?.status ?? "missing"));
	const firstId = CANONICAL_IDS[0];
	const coldFirst = cold ? testIn(cold, firstId)?.durationMs : undefined;
	const warmFirst = warmReps(all).length > 0 ? median(durationsOf(warmReps(all), firstId)) : Number.NaN;
	const warmWallMedian = warmReps(all).length > 0 ? median(warmReps(all).map((r) => r.wallMs)) : Number.NaN;
	return {
		warmSuiteWall,
		...(cold ? { coldSuiteWallMs: round1(cold.wallMs) } : {}),
		perTest: perTest as Record<CanonicalId, PerTestStats>,
		overheadMs: overheads.length > 0 ? round1(median(overheads)) : Number.NaN,
		...(cold && Number.isFinite(warmWallMedian)
			? { coldStartMs: round1(cold.wallMs - warmWallMedian + input.prepareMs) }
			: {}),
		...(coldFirst !== undefined && Number.isFinite(warmFirst)
			? { firstTestOverheadMs: round1(coldFirst - warmFirst) }
			: {}),
		prepareMs: round1(input.prepareMs),
		teardownMs: round1(input.teardownMs),
		...(steps.length > 0 ? { stepLatency: dist(steps) } : {}),
		passRate: passRate(allStatuses),
		flakeRate: flakeRate(allStatuses),
	};
}

/**
 * Cross-framework ratios: each framework's warm suite median and per-test medians over the fastest
 * framework's. Only frameworks with a finite median AND a 100% pass rate (suite-wide for the suite ratio,
 * per test for the test ratio) can be "fastest": a failed test ends early, so it would win on time alone.
 */
export function withRatios<T extends { stats: FrameworkStats }>(frameworks: readonly T[]): T[] {
	const suiteMedians = frameworks
		.filter((f) => f.stats.passRate === 1)
		.map((f) => f.stats.warmSuiteWall.median)
		.filter(Number.isFinite);
	const fastestSuite = suiteMedians.length > 0 ? Math.min(...suiteMedians) : undefined;
	const fastestTest: Partial<Record<CanonicalId, number>> = {};
	for (const id of CANONICAL_IDS) {
		const medians = frameworks
			.map((f) => f.stats.perTest[id])
			.filter((t) => t !== undefined && t.passRate === 1)
			.map((t) => t.median)
			.filter(Number.isFinite);
		if (medians.length > 0) fastestTest[id] = Math.min(...medians);
	}
	return frameworks.map((f) => {
		const perTest: Record<string, PerTestStats> = {};
		for (const id of CANONICAL_IDS) {
			const t = f.stats.perTest[id];
			if (t === undefined) continue;
			const fastest = fastestTest[id];
			const r = fastest !== undefined ? ratio(t.median, fastest) : undefined;
			perTest[id] = r !== undefined ? { ...t, ratioToFastest: r } : t;
		}
		const suite = fastestSuite !== undefined ? ratio(f.stats.warmSuiteWall.median, fastestSuite) : undefined;
		return {
			...f,
			stats: {
				...f.stats,
				perTest: perTest as Record<CanonicalId, PerTestStats>,
				...(suite !== undefined ? { ratioToFastestSuite: suite } : {}),
			},
		};
	});
}
