import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where code deep inside a driver call (an adb command, the dump route, a settle verdict) leaves a note for the
 * `span` that is timing that call, without the driver knowing about tracing: a note outside a span goes nowhere.
 * Values are scalars so a span stays one short JSON line.
 */
export type SpanDetail = Record<string, string | number | boolean>;

const collectors = new AsyncLocalStorage<SpanDetail>();

/** Runs `fn` with `notes` as the sink for every {@link noteSpanDetail} / {@link addSpanDetail} made inside it, awaits included. */
export function collectSpanDetail<T>(notes: SpanDetail, fn: () => T): T {
	return collectors.run(notes, fn);
}

/** Sets `key` on the innermost span being timed. */
export function noteSpanDetail(key: string, value: string | number | boolean): void {
	const notes = collectors.getStore();
	if (notes !== undefined) notes[key] = value;
}

/** Adds `amount` to a numeric `key` of the innermost span (a counter or a sum of durations). */
export function addSpanDetail(key: string, amount: number): void {
	const notes = collectors.getStore();
	if (notes === undefined) return;
	const before = notes[key];
	notes[key] = (typeof before === "number" ? before : 0) + amount;
}
