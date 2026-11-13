/** Console tail of a native log: the last few lines worth reading next to a failure. */

export const TAIL_LINES = 20;
const MAX_MESSAGE = 200;
const COMPOSE_FAILURE = "<compose failure";

type Entry = { sortKey: string; severe: boolean; text: string };

const cut = (message: string): string => (message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message);

/** Severe entries first (most recent), then the most recent rest up to the cap, in time order. */
function pick(entries: Entry[]): string[] {
	const ordered = [...entries].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
	const severe = ordered.filter((e) => e.severe).slice(-TAIL_LINES);
	const rest = ordered.filter((e) => !e.severe).slice(-(TAIL_LINES - severe.length));
	return [...severe, ...rest]
		.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
		.map((e) => e.text);
}

type IosEvent = {
	eventType?: string;
	messageType?: string;
	subsystem?: string;
	category?: string;
	timestamp?: string;
	eventMessage?: string;
};

function parseIos(text: string): IosEvent[] {
	const events: IosEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed === "object" && parsed !== null) events.push(parsed as IosEvent);
		} catch {
			// a truncated first line of a tailed log
		}
	}
	return events;
}

/** `ndjson` of `log show` → up to {@link TAIL_LINES} readable lines; unresolved messages are never shown. */
export function iosTail(ndjson: string): string[] {
	const entries: Entry[] = [];
	for (const event of parseIos(ndjson)) {
		const message = event.eventMessage;
		if (event.eventType !== "logEvent" || !message || message.startsWith(COMPOSE_FAILURE)) continue;
		const stamp = event.timestamp ?? "";
		const time = /(\d\d:\d\d:\d\d\.\d{3})/.exec(stamp)?.[1] ?? stamp;
		const level = (event.messageType ?? "Default").toLowerCase();
		const where = [event.subsystem, event.category].filter(Boolean).join("/");
		entries.push({
			sortKey: stamp,
			severe: level === "error" || level === "fault",
			text: cut(`${time} ${level} ${where ? `${where} ` : ""}${message}`),
		});
	}
	return pick(entries);
}

/** How many of a `log show` ndjson's messages could not be composed (`<compose failure …>`). */
export function unresolvedShare(ndjson: string): { unresolved: number; total: number } {
	let unresolved = 0;
	let total = 0;
	for (const event of parseIos(ndjson)) {
		if (event.eventType !== "logEvent" || !event.eventMessage) continue;
		total += 1;
		if (event.eventMessage.startsWith(COMPOSE_FAILURE)) unresolved += 1;
	}
	return { unresolved, total };
}

/** `logcat -v epoch` text → up to {@link TAIL_LINES} lines, E/F/W first. */
export function androidTail(logcat: string): string[] {
	const entries: Entry[] = [];
	for (const line of logcat.split("\n")) {
		const m = /^(\d+\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s/.exec(line);
		if (!m) continue;
		entries.push({ sortKey: (m[1] ?? "").padStart(20, "0"), severe: "EFW".includes(m[2] ?? ""), text: cut(line) });
	}
	return pick(entries);
}

/** Console block for a failed attempt: a header, then each line indented. Empty for no lines. */
export function formatNativeTail(lines: readonly string[]): string[] {
	if (lines.length === 0) return [];
	return [
		`  native log, last ${lines.length} line${lines.length === 1 ? "" : "s"} before the failure (full: native.log):`,
		...lines.map((l) => `    ${l}`),
	];
}
