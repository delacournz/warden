import { isTrialExpired, TRIAL_DAYS } from "@/modules/conditions/utils/trial";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Where the trial stands: days still left while it runs, whole days since its end once it is over. */
export type TrialState = { kind: "active"; daysLeft: number } | { kind: "expired"; daysAgo: number };

/**
 * The trial's state at `now`. The expiry rule is `isTrialExpired`; days left round up so a few real seconds after an
 * `advance 10d` still read 4, and never drop below 1 while the trial is active or above `TRIAL_DAYS` for a clock
 * moved back before the start.
 */
export function trialStateOf(now: number, start: number): TrialState {
	if (isTrialExpired(now, start)) {
		const end = start + TRIAL_DAYS * DAY_MS;
		return { kind: "expired", daysAgo: Math.floor((now - end) / DAY_MS) };
	}
	const left = Math.ceil((TRIAL_DAYS * DAY_MS - (now - start)) / DAY_MS);
	return { kind: "active", daysLeft: Math.min(TRIAL_DAYS, Math.max(1, left)) };
}

/** How many of the dial's segments are spent: elapsed days while active, `TRIAL_DAYS + 1` (all of them) once expired. */
export function trialLevel(state: TrialState): number {
	return state.kind === "active" ? TRIAL_DAYS - state.daysLeft : TRIAL_DAYS + 1;
}

/** `30 Oct`: day and short month of the UTC date, so it matches the ISO time shown beside it. */
export function formatDay(ms: number): string {
	const date = new Date(ms);
	return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** The hero headline and its one supporting line. */
export function trialCopy(state: TrialState, start: number): { title: string; body: string } {
	if (state.kind === "active") {
		return {
			title: state.daysLeft === 1 ? "1 day left" : `${state.daysLeft} days left`,
			body: `Trial started ${formatDay(start)}, ends ${formatDay(start + TRIAL_DAYS * DAY_MS)}.`,
		};
	}
	const ended = formatDay(start + TRIAL_DAYS * DAY_MS);
	const ago = state.daysAgo === 0 ? "today" : state.daysAgo === 1 ? "1 day ago" : `${state.daysAgo} days ago`;
	return { title: "Trial expired", body: `Ended ${ended}, ${ago}.` };
}

/**
 * A signed clock distance: `+10d 0h`, `−15d 0h`, `+5h 30m`, `+12m`, `+30s`, or `0s` under half a second.
 * Distances over an hour round to the minute, so the few milliseconds a tick adds to a jump never change the hours.
 */
export function formatOffset(ms: number): string {
	let seconds = Math.round(Math.abs(ms) / 1000);
	if (seconds === 0) return "0s";
	if (seconds >= 3600) seconds = Math.round(seconds / 60) * 60;
	const sign = ms < 0 ? "−" : "+";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${sign}${days}d ${hours}h`;
	if (hours > 0) return `${sign}${hours}h ${minutes}m`;
	if (minutes > 0) return `${sign}${minutes}m`;
	return `${sign}${seconds}s`;
}
