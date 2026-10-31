/** Why a request failed, in the words the readout and the log show. */
export type FailureReason = "offline" | "reset" | "timeout" | `http ${number}`;

/** One measured request. `id` increments per request, `at` is milliseconds since the screen opened. */
export type Sample =
	| { id: number; at: number; ok: true; ms: number; status: number }
	| { id: number; at: number; ok: false; ms: number; reason: FailureReason };

/** The strip draws this many requests; older ones fall off its left edge. */
export const STRIP_SIZE = 24;

/** Median of `values`, or null when there are none. */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const lower = sorted[mid - 1] ?? 0;
	const upper = sorted[mid] ?? 0;
	return sorted.length % 2 === 1 ? upper : (lower + upper) / 2;
}

/** `buffer` with `sample` appended as the newest, trimmed to the latest `max`. Never mutates. */
export function pushSample(buffer: readonly Sample[], sample: Sample, max: number): readonly Sample[] {
	return [...buffer, sample].slice(-max);
}

/**
 * Names a failed request. fetch reports a reset and an offline link with the same message, so the link decides:
 * a network error while the link is down is `offline`, while it is up it is a `reset`.
 */
export function describeFailure(error: string | null, status: number | null, linkUp: boolean): FailureReason {
	if (error === "Timed out") return "timeout";
	if (status !== null) return `http ${status}`;
	return linkUp ? "reset" : "offline";
}

const FASTEST_MS = 20;
const SLOWEST_MS = 4000;
const FLOOR_PX = 4;

/** Bar height for a latency on a log scale between 20 ms and 4 s, never below a 4 px stub. */
export function barHeight(ms: number, maxHeight: number): number {
	const t = (Math.log(ms) - Math.log(FASTEST_MS)) / (Math.log(SLOWEST_MS) - Math.log(FASTEST_MS));
	return Math.min(maxHeight, Math.max(FLOOR_PX, FLOOR_PX + t * (maxHeight - FLOOR_PX)));
}

/** A latency as `48 ms` below a second, `1.9 s` above. */
export function formatMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** The `net-last` readout. */
export function lastText(sample: Sample | undefined): string {
	if (!sample) return "-";
	return sample.ok ? `${sample.status} · ${formatMs(sample.ms)}` : `failed · ${sample.reason}`;
}

/** The `net-p50` readout: median latency of the requests that landed. */
export function p50Text(samples: readonly Sample[]): string {
	const landed = samples.flatMap((s) => (s.ok ? [s.ms] : []));
	const mid = median(landed);
	return mid === null ? "-" : formatMs(mid);
}

/** The `net-count` readout. */
export function countText(tally: { ok: number; failed: number }): string {
	return `${tally.ok} ok · ${tally.failed} failed`;
}
