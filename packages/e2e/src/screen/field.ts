import { ok } from "@delacour/warden-types/result";
import type { Driver, DriverError, DriverResult, Point } from "../driver/driver.types";
import { canSelectAll, pressKeys, type Sleep, typeText } from "../driver/typing";
import { clearKeyPresses, fieldContent, fieldValue } from "./actions";
import { entryOfElement, type NodeEntry } from "./nodes";

/**
 * Reading back what a text field holds after typing, shared by the spec `fill` and `warden ui fill`.
 *
 * The accessibility value lags the keys by 100-200 ms (the app digests ~50 ms a character), and a controlled input
 * can lose a key under load. So a read is never trusted on its own: the field must hold the wanted text on
 * `CONFIRM_READS` consecutive reads `FIELD_POLL_MS` apart (a stale value from before the edit can equal the wanted
 * text once), and the wait extends while the value is still changing.
 */

export const FIELD_POLL_MS = 50;
/** While the value keeps changing, wait at least this long for its next change. */
export const FIELD_PROGRESS_MS = 1000;
/** Consecutive reads that must equal the wanted text. */
export const CONFIRM_READS = 2;
/** When the field already held the wanted text before the edit, a stale read can match: trust only a longer run. */
export const STALE_RISK_READS = 4;

/**
 * Consecutive matching reads to trust for `text` typed into `entry` (the field as seen before the edit): the longer
 * `STALE_RISK_READS` only when it already held that text. A placeholder shown as the value (one the element names, or a
 * secure field's) is not text it held.
 */
export function confirmReadsFor(entry: NodeEntry | undefined, text: string): number {
	if (entry === undefined || text === "") return CONFIRM_READS;
	return fieldValue(entry) === text ? STALE_RISK_READS : CONFIRM_READS;
}

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

/**
 * How a field is emptied. `auto` selects everything and presses one Backspace when the driver can select all, else
 * presses one Backspace per character; `counted` always presses one per character (the retry after select-all left
 * text behind, e.g. a field that refuses Cmd+A).
 */
export type ClearMethod = "auto" | "counted";

/**
 * Taps `point` (the caret spot at the field's right end, `focusPoint`) and empties what `entry` shows; no `entry`
 * (a bare coordinate) means nothing to clear. A field that holds nothing, or only a placeholder, gets no keys. The one
 * clear routine behind the spec `fill`/`clear` and `warden ui fill`.
 *
 * Plain text is selected whole and deleted with one Backspace when the driver offers select-all (a driver that
 * rejects it gets the counted presses). Secure fields are always backspaced by their dots: they cannot be read back,
 * so a select-all that did nothing would go unnoticed.
 */
export async function focusAndClear(
	driver: Driver,
	sleep: Sleep,
	point: Point,
	entry: NodeEntry | undefined,
	method: ClearMethod = "auto"
): DriverResult<void> {
	const focused = await driver.tap(point);
	if (!focused.success) return focused;
	if (entry === undefined) return ok(undefined);
	const content = fieldContent(entry);
	if (content.kind === "empty") return ok(undefined);
	if (content.kind === "text" && method === "auto" && canSelectAll(driver)) {
		const selected = await driver.selectAll();
		if (selected.success) return pressKeys(driver, sleep, "Backspace", 1);
	}
	return pressKeys(driver, sleep, "Backspace", clearKeyPresses(entry));
}

/** `focusAndClear`, then types `text` (nothing for the empty string). */
export async function focusClearType(
	driver: Driver,
	sleep: Sleep,
	point: Point,
	entry: NodeEntry | undefined,
	text: string,
	method: ClearMethod = "auto"
): DriverResult<void> {
	const cleared = await focusAndClear(driver, sleep, point, entry, method);
	if (!cleared.success) return cleared;
	return text === "" ? ok(undefined) : typeText(driver, sleep, text);
}
