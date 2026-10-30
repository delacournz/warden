import { isTrialExpired } from "@/modules/conditions/utils/trial";
import type { LogLine } from "@/modules/showcase/components/event-log";
import { formatOffset } from "./trial-view";

/** One reading of both clocks: the device wall clock (`Date.now()`, which warden moves) and the monotonic one. */
export type Sample = { wall: number; mono: number };

/** A wall clock this far off the monotonic one between two ticks is a jump, not drift. */
export const JUMP_THRESHOLD_MS = 5000;

/** The log keeps this many lines, newest first. */
export const MAX_EVENTS = 6;

/** How far the wall clock moved beyond real time between two samples, or `null` when it only ticked along. */
export function jumpOf(prev: Sample, next: Sample): number | null {
	const deviation = next.wall - prev.wall - (next.mono - prev.mono);
	return Math.abs(deviation) > JUMP_THRESHOLD_MS ? deviation : null;
}

/**
 * What changed between two samples, oldest first: a clock jump, then the trial expiring or coming back. `at` stamps
 * the lines (milliseconds since the screen opened).
 */
export function eventsFor(prev: Sample, next: Sample, start: number, at: number): LogLine[] {
	const lines: LogLine[] = [];
	const jump = jumpOf(prev, next);
	if (jump !== null) lines.push({ at, text: `clock jumped ${formatOffset(jump)}`, tone: "scan" });
	const wasExpired = isTrialExpired(prev.wall, start);
	const isExpired = isTrialExpired(next.wall, start);
	if (!wasExpired && isExpired) lines.push({ at, text: "trial expired", tone: "warn" });
	if (wasExpired && !isExpired) lines.push({ at, text: "trial active again", tone: "open" });
	return lines;
}

/** Puts `lines` (oldest first) on top of `log` (newest first) and keeps the newest `MAX_EVENTS`. */
export function pushEvents(log: readonly LogLine[], lines: readonly LogLine[]): LogLine[] {
	return [...[...lines].reverse(), ...log].slice(0, MAX_EVENTS);
}
