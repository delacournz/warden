import type { AttemptContext } from "./fixtures.types";

/**
 * One reported step of the running attempt: writes `step-start` / `step-end` to `trace.jsonl` (and
 * so to the console), nests by `depth`, and gives up as soon as the attempt deadline aborts, even
 * if `fn` is a driver call that never answers. Without an attempt it just runs `fn`.
 */
export class StepRunner {
	async run<T>(
		attempt: AttemptContext | undefined,
		kind: string,
		label: string,
		fn: () => Promise<T>,
		now: () => number = Date.now
	): Promise<T> {
		if (attempt === undefined) return fn();
		if (attempt.signal.aborted) throw this.abortReason(attempt.signal);

		const startedAt = now();
		attempt.trace.write({ type: "step-start", ts: startedAt, kind, label });
		attempt.depth += 1;
		const abort = this.aborted(attempt.signal);
		try {
			const value = await Promise.race([fn(), abort.promise]);
			attempt.depth -= 1;
			attempt.trace.write({ type: "step-end", ts: now(), kind, label, status: "passed", ms: now() - startedAt });
			return value;
		} catch (error) {
			attempt.depth -= 1;
			attempt.trace.write({
				type: "step-end",
				ts: now(),
				kind,
				label,
				status: "failed",
				ms: now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			abort.dispose();
		}
	}

	private abortReason(signal: AbortSignal): unknown {
		return signal.reason ?? new Error("aborted");
	}

	/** Rejects when the signal aborts (immediately if it already has). */
	private aborted(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
		let dispose = (): void => undefined;
		const promise = new Promise<never>((_, reject) => {
			if (signal.aborted) {
				reject(this.abortReason(signal));
				return;
			}
			const onAbort = (): void => reject(this.abortReason(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			dispose = () => signal.removeEventListener("abort", onAbort);
		});
		promise.catch(() => undefined);
		return { promise, dispose };
	}
}

export const stepRunner = new StepRunner();
