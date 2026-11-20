import { type AsyncResult, err } from "@delacour/warden-types/result";

/**
 * What `simctl create` says (exit 145) when CoreSimulator lists a runtime it will not take a device on yet.
 * Seen on a freshly booted hosted runner image: the first create of a suite was refused, the same call
 * worked seconds later. Callers only ever pass a runtime `simctl list runtimes` reported available, so
 * the refusal is a not-ready runtime, never a typo.
 */
export const RUNTIME_REFUSED = "Invalid runtime";

/** How long a create waits for a listed runtime to accept devices, and how often it asks again. */
export const CREATE_RETRY = { waitMs: 60_000, pollMs: 3_000 } as const;

export type CreateRetry = { waitMs: number; pollMs: number };

export type CreateRetryDeps = {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log?: (line: string) => void;
};

function shortRuntime(runtimeId: string): string {
	return runtimeId.replace("com.apple.CoreSimulator.SimRuntime.", "");
}

/**
 * Run a `simctl create` attempt, asking again every `pollMs` while it fails with `Invalid runtime`, for up to
 * `waitMs`. Any other failure (a timeout, a bad device type) returns at once. Logs when it starts waiting and
 * when the runtime gave in, so a slow runtime shows in CI output; the final error says how long it was refused.
 */
export async function createAcceptingRuntime(
	attempt: () => AsyncResult<string>,
	runtimeId: string,
	deps: CreateRetryDeps,
	retry: CreateRetry = CREATE_RETRY
): AsyncResult<string> {
	const started = deps.now();
	const runtime = shortRuntime(runtimeId);
	let result = await attempt();
	let retried = false;
	while (!result.success && result.error.includes(RUNTIME_REFUSED)) {
		const waited = deps.now() - started;
		const left = retry.waitMs - waited;
		if (left <= 0) {
			return err(
				`${result.error} (${runtime} is listed by \`simctl list runtimes\` but refused new simulators for ${Math.round(waited / 1000)}s)`
			);
		}
		if (!retried) {
			deps.log?.(
				`${runtime} is listed but refuses new simulators yet (${RUNTIME_REFUSED}); retrying for up to ${Math.round(retry.waitMs / 1000)}s`
			);
		}
		retried = true;
		await deps.sleep(Math.min(retry.pollMs, left));
		result = await attempt();
	}
	if (retried && result.success) {
		deps.log?.(`${runtime} accepted the simulator after ${Math.round((deps.now() - started) / 1000)}s`);
	}
	return result;
}
