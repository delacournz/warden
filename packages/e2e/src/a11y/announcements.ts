import type { Result } from "@delacour/warden-types/result";
import { canReadA11yEvents } from "../driver/a11y-events";
import type { Driver, DriverError } from "../driver/driver.types";
import { driverError } from "../driver/errors";
import type { A11yEvent } from "./a11y.types";

export type WaitForAnnouncementOptions = {
	timeoutMs?: number;
	/** cursor from an earlier read: only events after it count (default: from the start) */
	since?: number;
	pollMs?: number;
	/** injected clock and sleep (tests) */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
};

export const ANNOUNCEMENT_TIMEOUT_MS = 5_000;
export const ANNOUNCEMENT_POLL_MS = 100;

export type AnnouncementMatch = { event: A11yEvent; cursor: number };

const ANNOUNCING: ReadonlySet<A11yEvent["kind"]> = new Set(["announcement", "live-region"]);

function matches(event: A11yEvent, match: string | RegExp): boolean {
	if (!ANNOUNCING.has(event.kind) || event.text === undefined) return false;
	if (typeof match === "string") return event.text.includes(match);
	match.lastIndex = 0;
	return match.test(event.text);
}

function withDefaults(opts: WaitForAnnouncementOptions) {
	return {
		now: opts.now ?? Date.now,
		sleep: opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
		timeoutMs: opts.timeoutMs ?? ANNOUNCEMENT_TIMEOUT_MS,
		pollMs: opts.pollMs ?? ANNOUNCEMENT_POLL_MS,
	};
}

/**
 * Poll the driver's a11y events until an announcement or live-region change whose text contains `match` (string) or
 * matches it (RegExp) arrives. `E_UNSUPPORTED` when the driver cannot read events, `E_TIMEOUT` (with the texts seen)
 * when nothing matched in time. The returned `cursor` is where the next wait should start.
 */
export async function waitForAnnouncement(
	driver: Driver,
	match: string | RegExp,
	opts: WaitForAnnouncementOptions = {}
): Promise<Result<AnnouncementMatch, DriverError>> {
	if (!canReadA11yEvents(driver)) {
		return {
			success: false,
			error: driverError("E_UNSUPPORTED", "this driver cannot read announcements (no a11yEvents capability)"),
		};
	}
	const { now, sleep, timeoutMs, pollMs } = withDefaults(opts);
	const deadline = now() + timeoutMs;
	let cursor = opts.since;
	const seen: string[] = [];
	for (;;) {
		const read = await driver.a11yEvents(cursor);
		if (!read.success) return read;
		cursor = read.data.cursor;
		const hit = read.data.events.find((event) => matches(event, match));
		if (hit) return { success: true, data: { event: hit, cursor: read.data.cursor } };
		for (const event of read.data.events) if (event.text !== undefined) seen.push(event.text);
		if (now() >= deadline) {
			return {
				success: false,
				error: driverError("E_TIMEOUT", `no announcement matched ${String(match)} within ${timeoutMs} ms`, {
					detail: { seen: seen.slice(-10), cursor },
				}),
			};
		}
		await sleep(pollMs);
	}
}
