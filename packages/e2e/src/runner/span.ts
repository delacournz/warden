import { collectSpanDetail, type SpanDetail } from "../driver/span-detail";
import type { TraceEvent } from "./trace";

/** Where spans go: the running attempt's `trace.jsonl` writer. */
export type SpanSink = { write(event: TraceEvent): void };

export type SpanOutcome = { ok: boolean; code?: string };

export type SpanOptions<T> = {
	/** clock for `ts` and `ms`; default `Date.now` */
	now?: () => number;
	/** whether a call that did not throw still failed (a driver `Result`) */
	verdict?: (value: T) => SpanOutcome;
	/** scalars read off the result, merged over what the call noted with `noteSpanDetail` */
	detail?: (value: T) => SpanDetail | undefined;
};

/** Times one call as a `span` (`device.*`, `read.*`); see {@link runSpan}. */
export type SpanRunner = <T>(op: string, fn: () => Promise<T>, options?: SpanOptions<T>) => Promise<T>;

/** The `code` of a thrown error (`E2eError`, a driver error), else `ERROR`. */
export function codeOf(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return "ERROR";
}

/**
 * Writes one `span` event: `ts` is when the call started, `ms` how long it took. Tracing is diagnostic, so a sink
 * that throws, or an `outcome` that does, never fails the call being timed.
 */
export function writeSpan(
	sink: SpanSink,
	span: { op: string; ts: number; ms: number; notes: SpanDetail },
	outcome: () => SpanOutcome & { extra?: SpanDetail }
): void {
	try {
		const { ok, code, extra } = outcome();
		const detail = { ...span.notes, ...extra };
		sink.write({
			type: "span",
			ts: span.ts,
			op: span.op,
			ms: span.ms,
			ok,
			...(code === undefined ? {} : { code }),
			...(Object.keys(detail).length === 0 ? {} : { detail }),
		});
	} catch {
		// the trace is diagnostic: never turn a working call into a failing one
	}
}

/**
 * Runs `fn` and writes one `span` event for it to `sink`: `ok`/`code` from the outcome, a throw recorded and
 * rethrown unchanged. Without a sink (no attempt is running) it is just `fn()`. The sink is taken when the call
 * starts, so a call that outlives its attempt still reports to that attempt's trace, never the next test's.
 */
export async function runSpan<T>(
	sink: SpanSink | undefined,
	op: string,
	fn: () => Promise<T>,
	options: SpanOptions<T> = {}
): Promise<T> {
	if (sink === undefined) return fn();
	const now = options.now ?? Date.now;
	const notes: SpanDetail = {};
	const ts = now();
	let value: T;
	try {
		value = await collectSpanDetail(notes, fn);
	} catch (error) {
		writeSpan(sink, { op, ts, ms: now() - ts, notes }, () => ({ ok: false, code: codeOf(error) }));
		throw error;
	}
	writeSpan(sink, { op, ts, ms: now() - ts, notes }, () => ({
		...(options.verdict?.(value) ?? { ok: true }),
		extra: options.detail?.(value),
	}));
	return value;
}
