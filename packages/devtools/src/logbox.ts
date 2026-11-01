import type { Sleep } from "./devtools.types";
import { LOGBOX_EXPRESSION } from "./logbox.script";
import type { DevtoolsSession } from "./session";
import { timer } from "./timer";

/** What {@link LogBoxMuter} needs of a devtools session (or facet). */
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

/**
 * Keeps React Native's LogBox off in the attached app (see `logbox.script.ts`): now, and again in every new JS context
 * (`reconnected` after a relaunch or JS reload). A context whose bundle has not run yet is tried again every
 * `intervalMs`; a newer context or `stop()` ends the older context's tries.
 */
export class LogBoxMuter implements LogBoxMute {
	readonly settled: Promise<void>;
	private readonly sleep: Sleep;
	private readonly intervalMs: number;
	private readonly attempts: number;
	private readonly off: () => void;
	private generation = 0;
	private stopped = false;

	constructor(
		private readonly session: LogBoxSession,
		private readonly options: MuteLogBoxOptions = {}
	) {
		this.sleep = options.sleep ?? timer.sleep;
		this.intervalMs = options.intervalMs ?? INTERVAL_MS;
		this.attempts = options.attempts ?? ATTEMPTS;
		this.off = session.on("reconnected", () => {
			void this.start();
		});
		this.settled = this.start();
	}

	stop(): void {
		this.stopped = true;
		this.off();
	}

	private start(): Promise<void> {
		this.generation += 1;
		return this.apply(this.generation);
	}

	/** `undefined` once LogBox is off, else why it is not (yet) */
	private async tryOnce(): Promise<string | undefined> {
		const reply = await this.session.evaluate(LOGBOX_EXPRESSION);
		if (!reply.success) return reply.error.message;
		return reply.data === "off" ? undefined : String(reply.data);
	}

	private async apply(mine: number): Promise<void> {
		const current = (): boolean => !this.stopped && mine === this.generation;
		let last: string | undefined = "no reply";
		for (let attempt = 1; attempt <= this.attempts && current(); attempt++) {
			last = await this.tryOnce();
			if (last === undefined) return;
			if (attempt < this.attempts) await this.sleep(this.intervalMs);
		}
		if (current()) this.options.log?.(`devtools: LogBox left on (${last} after ${this.attempts} attempts)`);
	}
}
