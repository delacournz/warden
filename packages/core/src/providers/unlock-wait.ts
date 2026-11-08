import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { CLAIM_ABORTED } from "../claim";
import { formatDuration } from "../duration";

/**
 * Before a physical iPhone is claimed: if it is locked, say so once and wait for the person to unlock it. Nothing
 * here touches the store; the wait happens before any lease is taken. warden never unlocks a phone.
 * `devicectl` has `device notification observe` for Darwin notifications, but no documented lock-state name, so the
 * wait polls `lockState`.
 */

/** How long a claim waits for a locked phone to be unlocked. */
export const UNLOCK_WAIT_MS = 120_000;
/** Between two `lockState` reads while waiting. */
export const UNLOCK_POLL_MS = 10_000;
/** Between two "still locked" progress lines. */
export const UNLOCK_PROGRESS_MS = 30_000;

export const DEVICE_LOCKED_CODE = "device_locked";
export const DEVICE_LOCKED_HINT = "unlock the phone, then retry";

/** The claim error for a phone that is locked: `device_locked: <name> is locked`. */
export const deviceLockedMessage = (name: string): string => `${DEVICE_LOCKED_CODE}: ${name} is locked`;

/** Is `error` a locked-phone failure of this module (or the install path's `device_locked:`)? */
export const isDeviceLockedError = (error: string): boolean => /(^|\b)device_locked: /.test(error);

export type UnlockWaitInput = {
	name: string;
	/** `devicectl device info lockState` */
	read: () => AsyncResult<{ locked: boolean }>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	/** progress lines (the caller's stderr) */
	log: (line: string) => void;
	/** `--no-wait`: fail at once instead of waiting */
	noWait: boolean;
	/** polled between reads: true ends the wait with `CLAIM_ABORTED` */
	abort?: () => boolean;
	waitMs?: number;
	pollMs?: number;
	progressMs?: number;
};

const UNLOCK_TIMING = { waitMs: UNLOCK_WAIT_MS, pollMs: UNLOCK_POLL_MS, progressMs: UNLOCK_PROGRESS_MS };

/** The timings `input` overrides (tests), nothing for the rest. */
function definedTiming(input: UnlockWaitInput): Partial<typeof UNLOCK_TIMING> {
	const { waitMs, pollMs, progressMs } = input;
	return {
		...(waitMs === undefined ? {} : { waitMs }),
		...(pollMs === undefined ? {} : { pollMs }),
		...(progressMs === undefined ? {} : { progressMs }),
	};
}

/**
 * Ok once the phone is unlocked (or when it gives no answer: offline is the claim's to report). A phone still
 * locked after the wait, or at once with `noWait`, is `device_locked: <name> is locked`.
 */
export async function waitUnlocked(input: UnlockWaitInput): AsyncResult<void> {
	const { waitMs, pollMs, progressMs } = { ...UNLOCK_TIMING, ...definedTiming(input) };
	const first = await input.read();
	if (!first.success || !first.data.locked) return ok(undefined);
	if (input.noWait) return err(deviceLockedMessage(input.name));
	input.log(`${input.name} is locked: unlock it to continue (waiting up to ${formatDuration(waitMs)})`);
	const startedAt = input.now();
	let nextProgress = startedAt + progressMs;
	for (;;) {
		const remaining = startedAt + waitMs - input.now();
		if (remaining <= 0) return err(`${deviceLockedMessage(input.name)} after ${formatDuration(waitMs)}`);
		await input.sleep(Math.min(pollMs, remaining));
		if (input.abort?.()) return err(CLAIM_ABORTED);
		const state = await input.read();
		if (!state.success || !state.data.locked) return ok(undefined);
		if (input.now() >= nextProgress && input.now() < startedAt + waitMs) {
			input.log(
				`${input.name} still locked: waiting for unlock (${formatDuration(input.now() - startedAt)} of ${formatDuration(waitMs)})`
			);
			nextProgress += progressMs;
		}
	}
}
