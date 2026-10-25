export type StartupStats = { runs: number; medianMs: number; p90Ms: number; minMs: number; maxMs: number };

/** Nearest-rank percentile of a sorted, non-empty list. */
function percentile(sorted: readonly number[], p: number): number {
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

/** Median (mean of the middle two for an even count), nearest-rank p90, min and max; undefined for no samples. */
export function summarize(values: readonly number[]): StartupStats | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
	return {
		runs: sorted.length,
		medianMs: Math.round(median),
		p90Ms: percentile(sorted, 90),
		minMs: sorted[0] as number,
		maxMs: sorted[sorted.length - 1] as number,
	};
}
