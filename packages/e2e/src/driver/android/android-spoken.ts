import type { SpokenLine } from "../../a11y/a11y.types";
import { announce } from "../../a11y/speech";
import { hasSpeechLines, parseTalkBackLog } from "../../a11y/talkback-log";
import type { DriverResult } from "../driver.types";
import type { SpokenRead } from "../screen-reader";
import type { SrEventsRead } from "./uiad-screen-reader";

/**
 * What TalkBack said since a cursor (`DrivesScreenReader.screenReaderSpoken`). The cursor is the device epoch ms of the
 * last line returned, whichever source it came from. Real speech needs TalkBack's verbose log (a developer setting
 * only its UI can change); without it the lines are composed by the speech model from the focus events the
 * screen-reader stream saw, labelled `simulated`. Whichever the log allows is used for the whole read, never a mix.
 */

export type SpokenDeps = {
	/** TalkBack's log, epoch timestamps (`TALKBACK_LOGCAT_ARGV`); undefined when it cannot be read */
	readLog(): Promise<string | undefined>;
	/** focus moves since 0 (the ring is small) */
	focusEvents(): DriverResult<SrEventsRead>;
	now(): number;
	sleep(ms: number): Promise<void>;
};

/** How long a focus move may precede its log line (measured 6-13 ms, so this is generous). */
const LOG_WAIT_MS = 50;
const LOG_ATTEMPTS = 6;

function cursorOf(lines: readonly SpokenLine[], since: number): number {
	return lines.reduce((max, line) => Math.max(max, line.at), since);
}

export async function readSpoken(deps: SpokenDeps, since = 0): DriverResult<SpokenRead> {
	const events = await deps.focusEvents();
	if (!events.success) return events;
	const fresh = events.data.events.filter((event) => event.at > since);

	let log = await deps.readLog();
	if (log !== undefined && hasSpeechLines(log)) {
		let lines = parseTalkBackLog(log, { now: deps.now(), since });
		// the log trails the event it speaks for by a few ms
		for (let attempt = 0; attempt < LOG_ATTEMPTS && lines.length === 0 && fresh.length > 0; attempt++) {
			await deps.sleep(LOG_WAIT_MS);
			log = (await deps.readLog()) ?? log;
			lines = parseTalkBackLog(log, { now: deps.now(), since });
		}
		return { success: true, data: { lines, cursor: cursorOf(lines, since) } };
	}

	const lines: SpokenLine[] = fresh.map((event) => ({
		text: announce(event.element, "android").text,
		at: event.at,
		source: "simulated",
	}));
	return { success: true, data: { lines, cursor: cursorOf(lines, since) } };
}
