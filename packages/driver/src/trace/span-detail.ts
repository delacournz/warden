import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where code deep inside a driver call (an adb command, the dump route, a settle verdict) leaves a note for the
 * `span` that is timing that call, without the driver knowing about tracing: a note outside a span goes nowhere.
 * Values are scalars so a span stays one short JSON line.
 */
export type SpanDetail = Record<string, string | number | boolean>;

/** The notes sink of the innermost running span. Use the shared {@link spanDetails} singleton. */
export class SpanDetails {
	private readonly collectors = new AsyncLocalStorage<SpanDetail>();

	/** Runs `fn` with `notes` as the sink for every {@link SpanDetails.note} / {@link SpanDetails.add} made inside it, awaits included. */
	collect<T>(notes: SpanDetail, fn: () => T): T {
		return this.collectors.run(notes, fn);
	}

	/** Sets `key` on the innermost span being timed. */
	note(key: string, value: string | number | boolean): void {
		const notes = this.collectors.getStore();
		if (notes !== undefined) notes[key] = value;
	}

	/** Adds `amount` to a numeric `key` of the innermost span (a counter or a sum of durations). */
	add(key: string, amount: number): void {
		const notes = this.collectors.getStore();
		if (notes === undefined) return;
		const before = notes[key];
		notes[key] = (typeof before === "number" ? before : 0) + amount;
	}
}

export const spanDetails = new SpanDetails();
