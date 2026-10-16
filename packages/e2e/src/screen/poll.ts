/** Time source for polling; tests inject `fakeClock()` so nothing really waits. */
export type Clock = {
	now(): number;
	/** resolves after `ms`, or early when `signal` aborts */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export const systemClock: Clock = {
	now: () => Date.now(),
	sleep(ms, signal) {
		return new Promise<void>((resolve) => {
			if (signal?.aborted) return resolve();
			const onAbort = (): void => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	},
};

export const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * Gap between attempts: `fastMs` while the poll is younger than `fastForMs`, `slowMs` after. Every attempt is a read of
 * the device (a full accessibility walk inside the app, or a 1.9 s `uiautomator dump` on Android), so a wait that has
 * not been satisfied for a second is not worth 10 reads a second.
 */
export type PollSchedule = { fastMs: number; fastForMs: number; slowMs: number };

export const DEFAULT_POLL_SCHEDULE: PollSchedule = {
	fastMs: DEFAULT_POLL_INTERVAL_MS,
	fastForMs: 1000,
	slowMs: 250,
};

/** One attempt: finished with a value, or not yet (with whatever the caller wants to report if time runs out). */
export type PollStep<T, S> =
	| { done: true; value: T }
	| {
			done: false;
			state: S;
			/** wake no later than this many ms from now, even when the schedule says to wait longer (a hold window ending) */
			maxWaitMs?: number;
	  };

export type PollResult<T, S> =
	| { status: "done"; value: T; attempts: number }
	| { status: "timeout"; last: S | undefined; attempts: number }
	| { status: "aborted"; attempts: number };

export type PollOptions = {
	/** a fixed gap between attempts, with no back-off; wins over `schedule` */
	intervalMs?: number;
	/** default `DEFAULT_POLL_SCHEDULE`: 100 ms for the first second, then 250 ms */
	schedule?: PollSchedule;
	timeoutMs: number;
	signal?: AbortSignal;
	now?: Clock["now"];
	sleep?: Clock["sleep"];
};

/**
 * Runs `step` until it is done, `timeoutMs` pass, or `signal` aborts. Always tries at least once (unless already
 * aborted); never sleeps past the deadline, so the last attempt is at the deadline. The gap follows `intervalMs`, else
 * `schedule` measured on the clock (a slow step reaches the slow gap sooner). Errors thrown by `step` end the poll.
 */
export async function poll<T, S = undefined>(
	step: (attempt: number) => Promise<PollStep<T, S>> | PollStep<T, S>,
	options: PollOptions
): Promise<PollResult<T, S>> {
	const now = options.now ?? systemClock.now;
	const sleep = options.sleep ?? systemClock.sleep;
	const schedule = options.schedule ?? DEFAULT_POLL_SCHEDULE;
	const startedAt = now();
	const deadline = startedAt + options.timeoutMs;
	const gap = (at: number): number =>
		options.intervalMs ?? (at - startedAt < schedule.fastForMs ? schedule.fastMs : schedule.slowMs);
	let attempts = 0;
	let last: S | undefined;
	for (;;) {
		if (options.signal?.aborted) return { status: "aborted", attempts };
		attempts += 1;
		const outcome = await step(attempts);
		if (outcome.done) return { status: "done", value: outcome.value, attempts };
		last = outcome.state;
		const at = now();
		const remaining = deadline - at;
		if (remaining <= 0) return { status: "timeout", last, attempts };
		const wanted = Math.min(gap(at), outcome.maxWaitMs === undefined ? Number.POSITIVE_INFINITY : outcome.maxWaitMs);
		await sleep(Math.max(0, Math.min(wanted, remaining)), options.signal);
	}
}
