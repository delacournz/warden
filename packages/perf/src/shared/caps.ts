/** A session with no `--max-duration` stops itself after this long. */
export const DEFAULT_MAX_DURATION_MS = 30_000;

/** `--max-duration` above this is clamped: long traces blow up the disk and skew the app under test. */
export const HARD_MAX_DURATION_MS = 300_000;

/** Lines `warden perf` prints in text mode before the `next:` block (the full report is on disk). */
export const MAX_TEXT_LINES = 40;

export type ClampedDuration = { ms: number; clamped: boolean; warning?: string };

/** The cap a session runs under: the default for no request, the hard max (with a warning) for too long a one. */
export function clampMaxDuration(requestedMs: number | undefined): ClampedDuration {
	if (requestedMs === undefined || requestedMs <= 0) return { ms: DEFAULT_MAX_DURATION_MS, clamped: false };
	if (requestedMs > HARD_MAX_DURATION_MS) {
		return {
			ms: HARD_MAX_DURATION_MS,
			clamped: true,
			warning: "--max-duration is capped at 5m: long sessions fill the disk and skew the app",
		};
	}
	return { ms: requestedMs, clamped: false };
}

/** Has a session that started at `startedWallMs` run for its whole `maxDurationMs` by `now`? */
export function overCap(session: { startedWallMs: number; maxDurationMs: number }, now: number): boolean {
	return now - session.startedWallMs >= session.maxDurationMs;
}
