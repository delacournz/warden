import type { PerfReport } from "./perf.types";

/** Ceilings a perf report must stay under; every field is optional and lower-is-better. */
export type PerfBudgets = {
	/** cold start, ms */
	startupColdMs?: number;
	/** share of janky frames, percent */
	jankPct?: number;
	/** the slowest React commit, ms */
	maxCommitMs?: number;
	/** 95th percentile app CPU, percent */
	p95CpuPct?: number;
	/** peak memory (PSS on Android, RSS on iOS), MB */
	peakMemoryMb?: number;
};

export const BUDGET_KEYS = ["startupColdMs", "jankPct", "maxCommitMs", "p95CpuPct", "peakMemoryMb"] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

/** One metric over its ceiling. */
export type PerfBreach = { metric: BudgetKey; value: number; budget: number };

/** What the report measured for `metric`, or `undefined` when its capture did not run. */
export function measured(report: Pick<PerfReport, "metrics">, metric: BudgetKey): number | undefined {
	const m = report.metrics;
	switch (metric) {
		case "startupColdMs":
			return m.startupColdMs;
		case "jankPct":
			return m.jankPct;
		case "maxCommitMs":
			return m.topCommitMs;
		case "p95CpuPct":
			return m.cpuP95Pct;
		case "peakMemoryMb": {
			const kb = Math.max(m.peakPssKb ?? 0, m.peakRssKb ?? 0);
			return kb > 0 ? kb / 1024 : undefined;
		}
	}
}

/**
 * Budgets set in `overrides` replace the same key of `base` (config); a metric the report has no number for (its
 * capture did not run) cannot breach.
 */
export function checkBudgets(
	report: Pick<PerfReport, "metrics">,
	base: PerfBudgets | undefined,
	overrides?: PerfBudgets
): PerfBreach[] {
	const budgets: PerfBudgets = { ...base, ...overrides };
	const breaches: PerfBreach[] = [];
	for (const metric of BUDGET_KEYS) {
		const budget = budgets[metric];
		if (budget === undefined) continue;
		const value = measured(report, metric);
		if (value !== undefined && value > budget) breaches.push({ metric, value, budget });
	}
	return breaches;
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** The failure text: each breach, then where the full report is. */
export function describeBreaches(breaches: readonly PerfBreach[], reportPath: string | undefined): string {
	const lines = breaches.map((b) => `  ${b.metric}: ${round(b.value)} > budget ${b.budget}`);
	return [
		`perf_budget: ${breaches.length} metric${breaches.length === 1 ? "" : "s"} over budget`,
		...lines,
		...(reportPath === undefined ? [] : [`  report: ${reportPath}`]),
	].join("\n");
}

/** Parses the `WARDEN_PERF_BUDGETS` JSON warden writes; unknown keys and non-numbers are dropped. */
export function parseBudgets(raw: string | undefined): PerfBudgets {
	if (raw === undefined || raw === "") return {};
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof json !== "object" || json === null) return {};
	const out: PerfBudgets = {};
	for (const key of BUDGET_KEYS) {
		const v = (json as Record<string, unknown>)[key];
		if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
	}
	return out;
}
