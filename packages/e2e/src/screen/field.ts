import type { Driver, DriverError } from "../driver/driver.types";
import { entryOfElement, type NodeEntry } from "./nodes";

/**
 * Reading back what a text field holds after typing, shared by the spec `fill` and `warden ui fill`.
 *
 * The accessibility value lags the keys by 100-200 ms (the app digests ~50 ms a character), and a controlled input
 * can lose a key under load. So a read is never trusted on its own: the field must hold the wanted text on
 * `CONFIRM_READS` consecutive reads `FIELD_POLL_MS` apart (a stale value from before the edit can equal the wanted
 * text once), and the wait extends while the value is still changing.
 */

export const FIELD_POLL_MS = 100;
/** While the value keeps changing, wait at least this long for its next change. */
export const FIELD_PROGRESS_MS = 1000;
/** Consecutive reads that must equal the wanted text. */
export const CONFIRM_READS = 2;
/** When the field already held the wanted text before the edit, a stale read can match: trust only a longer run. */
export const STALE_RISK_READS = 4;

export type FieldReading =
	| { kind: "value"; value: string }
	/** the field could not be read this time (gone, ambiguous, driver busy); `note` is what a failure message shows */
	| { kind: "unreadable"; note: string };

export type FieldOutcome<E> =
	| { status: "confirmed" }
	| { status: "mismatch"; held: string }
	| { status: "failed"; error: E };

export type ConfirmRequest<E> = {
	/** one look at the field; `{ ok: false }` ends the wait at once */
	read: () => Promise<{ ok: true; reading: FieldReading } | { ok: false; error: E }>;
	text: string;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	/** how long to keep looking when nothing changes */
	budgetMs: number;
	/** consecutive matching reads to trust; default `CONFIRM_READS` */
	reads?: number;
	/** hard cap including the extension for progress */
	maxMs?: number;
};

/** Polls the field until it holds `text` on consecutive reads, or the budget (extended while it changes) runs out. */
export async function confirmFieldValue<E>(request: ConfirmRequest<E>): Promise<FieldOutcome<E>> {
	const { now, sleep } = request;
	const start = now();
	const cap = request.maxMs === undefined ? Number.POSITIVE_INFINITY : start + request.maxMs;
	let deadline = Math.min(start + request.budgetMs, cap);
	let held = "(gone)";
	let streak = 0;
	for (;;) {
		const read = await request.read();
		if (!read.ok) return { status: "failed", error: read.error };
		const { reading } = read;
		if (reading.kind === "unreadable") {
			streak = 0;
			held = reading.note;
		} else if (reading.value === request.text) {
			streak += 1;
			if (streak >= (request.reads ?? CONFIRM_READS)) return { status: "confirmed" };
			held = reading.value;
			deadline = Math.max(deadline, Math.min(now() + 2 * FIELD_POLL_MS, cap));
		} else {
			streak = 0;
			if (reading.value !== held) deadline = Math.max(deadline, Math.min(now() + FIELD_PROGRESS_MS, cap));
			held = reading.value;
		}
		if (now() >= deadline) return { status: "mismatch", held };
		await sleep(FIELD_POLL_MS);
	}
}

/** What the field behind `wanted` shows right now by a hit-test at its centre (about 10 ms, unlike a full snapshot), or undefined when that cannot tell. */
export async function hitTestField(
	driver: Driver,
	wanted: NodeEntry
): Promise<{ ok: true; entry: NodeEntry | undefined } | { ok: false; error: DriverError }> {
	const { x, y, width, height } = wanted.element.frame;
	const hit = await driver.elementAtPoint({ x: x + width / 2, y: y + height / 2 });
	if (!hit.success) return { ok: false, error: hit.error };
	if (!hit.data) return { ok: true, entry: undefined };
	const entry = entryOfElement(hit.data, { platform: driver.platform });
	return { ok: true, entry: entry?.role === wanted.role ? entry : undefined };
}
