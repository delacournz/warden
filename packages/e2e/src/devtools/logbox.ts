import type { Sleep } from "./devtools.types";
import { LOGBOX_EXPRESSION } from "./logbox.script";
import type { DevtoolsSession } from "./session";

/** What {@link muteLogBox} needs of a devtools session (or facet). */
export type LogBoxSession = {
	evaluate: DevtoolsSession["evaluate"];
	on: (event: "reconnected", handler: () => void) => () => void;
};

export type MuteLogBoxOptions = {
	/** injectable for tests; defaults to a timer */
	sleep?: Sleep;
	/** pause between tries while the bundle is still loading (default 250 ms) */
	intervalMs?: number;
	/** tries per JS context before LogBox is left on (default 80: 20 s at the default interval) */
	attempts?: number;
	log?: (line: string) => void;
};

export type LogBoxMute = {
	/** resolves when the current JS context's tries end (LogBox off, given up, or stopped) */
	readonly settled: Promise<void>;
	stop(): void;
};

const INTERVAL_MS = 250;
const ATTEMPTS = 80;

const timerSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keeps React Native's LogBox off in the attached app (see `logbox.script.ts`): now, and again in every new JS context
 * (`reconnected` after a relaunch or JS reload). A context whose bundle has not run yet is tried again every
 * `intervalMs`; a newer context or `stop()` ends the older context's tries.
 */
export function muteLogBox(session: LogBoxSession, options: MuteLogBoxOptions = {}): LogBoxMute {
	const sleep = options.sleep ?? timerSleep;
	const intervalMs = options.intervalMs ?? INTERVAL_MS;
	const attempts = options.attempts ?? ATTEMPTS;
	let generation = 0;
	let stopped = false;

	/** `undefined` once LogBox is off, else why it is not (yet) */
	async function tryOnce(): Promise<string | undefined> {
		const reply = await session.evaluate(LOGBOX_EXPRESSION);
		if (!reply.success) return reply.error.message;
		return reply.data === "off" ? undefined : String(reply.data);
	}

	async function apply(mine: number): Promise<void> {
		const current = (): boolean => !stopped && mine === generation;
		let last: string | undefined = "no reply";
		for (let attempt = 1; attempt <= attempts && current(); attempt++) {
			last = await tryOnce();
			if (last === undefined) return;
			if (attempt < attempts) await sleep(intervalMs);
		}
		if (current()) options.log?.(`devtools: LogBox left on (${last} after ${attempts} attempts)`);
	}

	const start = (): Promise<void> => apply(++generation);
	const off = session.on("reconnected", () => {
		void start();
	});
	const settled = start();
	return {
		settled,
		stop() {
			stopped = true;
			off();
		},
	};
}
