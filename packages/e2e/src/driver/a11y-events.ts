import type { Result } from "@delacour/warden-types/result";
import type { A11yEvent, A11yEventKind, A11yEventSource } from "../a11y/a11y.types";
import type { Driver, DriverResult } from "./driver.types";

/**
 * Optional capability next to the frozen `Driver` interface (pattern: `ReadsA11y`): the announcements, live-region
 * changes and screen/layout notifications an app emitted since `since`. `cursor` is opaque to callers: pass the last
 * one back to get only what is new (Android: the server's sequence number; iOS: a byte offset into the inject events
 * file). `since` omitted reads from the start. `lost` is set when the Android ring overwrote events the caller never saw.
 * iOS needs the app launched with the injected library (`WARDEN_A11Y=1` / the `a11y` option) and answers
 * `E_UNSUPPORTED` otherwise.
 */
export type A11yEventsRead = { events: A11yEvent[]; cursor: number; lost?: boolean };

export type ReadsA11yEvents = { a11yEvents(since?: number): DriverResult<A11yEventsRead> };

export function canReadA11yEvents(driver: Driver): driver is Driver & ReadsA11yEvents {
	return typeof (driver as Partial<ReadsA11yEvents>).a11yEvents === "function";
}

const KINDS: ReadonlySet<string> = new Set<A11yEventKind>([
	"announcement",
	"live-region",
	"screen-changed",
	"layout-changed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One event object (either platform's wire shape is the same), or undefined when malformed. */
export function parseA11yEvent(value: unknown, source: A11yEventSource): A11yEvent | undefined {
	if (!isRecord(value) || typeof value.kind !== "string" || !KINDS.has(value.kind)) return undefined;
	if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
	if (value.text !== undefined && typeof value.text !== "string") return undefined;
	return {
		kind: value.kind as A11yEventKind,
		...(typeof value.text === "string" && value.text !== "" ? { text: value.text } : {}),
		at: value.at,
		source,
	};
}

/** The `a11yEvents` reply of `warden-uiad`: `{events:[{kind,text,at}], cursor, lost?}`. */
export function parseUiadA11yEvents(data: unknown): Result<A11yEventsRead, string> {
	if (!isRecord(data) || !Array.isArray(data.events) || typeof data.cursor !== "number") {
		return { success: false, error: "warden-uiad answered a11yEvents with an unexpected shape" };
	}
	const events: A11yEvent[] = [];
	for (const [index, raw] of data.events.entries()) {
		const event = parseA11yEvent(raw, "uiad");
		if (!event) return { success: false, error: `warden-uiad sent a malformed a11y event at ${index}` };
		events.push(event);
	}
	return { success: true, data: { events, cursor: data.cursor, ...(data.lost === true ? { lost: true } : {}) } };
}

/**
 * The injected library's `<state>.events` file (JSON lines, append-only) from byte offset `since`. Only lines that end
 * in a newline count: a half-written tail stays unread and the returned cursor stops before it, so the next read
 * starts there. A malformed complete line is skipped (the cursor moves past it). A `since` beyond the file (the file
 * was reset by a relaunch) restarts from 0.
 */
export function parseInjectEvents(text: string, since = 0): A11yEventsRead {
	const bytes = Buffer.from(text, "utf8");
	const start = since > bytes.length || since < 0 ? 0 : since;
	const end = bytes.lastIndexOf(0x0a) + 1;
	if (end <= start) return { events: [], cursor: start };
	const events: A11yEvent[] = [];
	for (const line of bytes.subarray(start, end).toString("utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			const event = parseA11yEvent(JSON.parse(line), "inject");
			if (event) events.push(event);
		} catch {
			// a corrupt line is skipped; the cursor still moves past it
		}
	}
	return { events, cursor: end };
}
