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

/** One attempt: finished with a value, or not yet (with whatever the caller wants to report if time runs out). */
export type PollStep<T, S> = { done: true; value: T } | { done: false; state: S };

export type PollResult<T, S> =
	| { status: "done"; value: T; attempts: number }
	| { status: "timeout"; last: S | undefined; attempts: number }
	| { status: "aborted"; attempts: number };

export type PollOptions = {
	/** default 100 */
	intervalMs?: number;
	timeoutMs: number;
	signal?: AbortSignal;
	now?: Clock["now"];
	sleep?: Clock["sleep"];
};

/**
 * Runs `step` until it is done, `timeoutMs` pass, or `signal` aborts. Always tries at least once (unless already
 * aborted); never sleeps past the deadline. Errors thrown by `step` end the poll.
 */
export async function poll<T, S = undefined>(
	step: (attempt: number) => Promise<PollStep<T, S>> | PollStep<T, S>,
	options: PollOptions
): Promise<PollResult<T, S>> {
	const now = options.now ?? systemClock.now;
	const sleep = options.sleep ?? systemClock.sleep;
	const interval = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const deadline = now() + options.timeoutMs;
	let attempts = 0;
	let last: S | undefined;
	for (;;) {
		if (options.signal?.aborted) return { status: "aborted", attempts };
		attempts += 1;
		const outcome = await step(attempts);
		if (outcome.done) return { status: "done", value: outcome.value, attempts };
		last = outcome.state;
		const remaining = deadline - now();
		if (remaining <= 0) return { status: "timeout", last, attempts };
		await sleep(Math.min(interval, remaining), options.signal);
	}
}
