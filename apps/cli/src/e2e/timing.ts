import { formatDuration } from "@delacour/warden-core/duration";

/**
 * Where a `warden e2e` run's wall time went (`e2e-report.json` `timing`, ms): `setup` = start → the
 * first spec process (plan, claim, boot, build/install, warm-up), `tests` = the spec processes'
 * window, `teardown` = after them → the verdict (logs, report, shutting devices down).
 */
export type E2eTiming = { totalMs: number; setupMs: number; testsMs: number; teardownMs: number };

/** The window the session ran specs in (epoch ms); absent when it stopped before any spec. */
export type TestsWindow = { testsStartedAt?: number; testsEndedAt?: number };

/** The split of a run that began at `began` and ends `now`, or undefined when no spec ran. */
export function runTiming(began: number, window: TestsWindow, now: number): E2eTiming | undefined {
	const { testsStartedAt: start, testsEndedAt: end } = window;
	if (start === undefined || end === undefined) return undefined;
	const span = (from: number, to: number) => Math.max(0, to - from);
	return {
		totalMs: span(began, now),
		setupMs: span(began, Math.min(start, now)),
		testsMs: span(start, Math.min(end, now)),
		teardownMs: span(end, now),
	};
}

/** `warden e2e: took 2m52s — setup 1m24s · tests 1m26s · teardown 2s` */
export function timingLine(t: E2eTiming): string {
	const d = formatDuration;
	return `warden e2e: took ${d(t.totalMs)} — setup ${d(t.setupMs)} · tests ${d(t.testsMs)} · teardown ${d(t.teardownMs)}`;
}
