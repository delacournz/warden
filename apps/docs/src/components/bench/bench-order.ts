const PLATFORM_ORDER: Record<string, number> = { ios: 0, android: 1 };

/** What ordering and labelling read from a summary. */
type RunKey = { runId: string; platform: string; date: string };

/** A committed summary and its file's basename: `docs/bench/<slug>.md` is its full report. */
export type SummaryEntry<S extends RunKey & { startedAt: string }> = { slug: string; summary: S };

/** Platforms in order (iOS, Android, then the rest), newest run first: by start time, so two runs on one date keep their order. */
export function orderSummaries<S extends RunKey & { startedAt: string }>(
	entries: readonly SummaryEntry<S>[]
): SummaryEntry<S>[] {
	return [...entries].sort(
		(a, b) =>
			(PLATFORM_ORDER[a.summary.platform] ?? 9) - (PLATFORM_ORDER[b.summary.platform] ?? 9) ||
			b.summary.startedAt.localeCompare(a.summary.startedAt)
	);
}

/** The run picker's label: the date, plus the run id when the platform has another run that day. */
export function runLabel(run: RunKey, runs: readonly RunKey[]): string {
	const sameDay = runs.filter((r) => r.platform === run.platform && r.date === run.date);
	return sameDay.length > 1 ? `${run.date} · ${run.runId}` : run.date;
}
