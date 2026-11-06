import type { BatchWorker } from "@delacour/warden-core/batch/schedule";
import { axVerdict } from "./ax-quarantine";
import type { EarlyWarm } from "./early-warm";

/** A device the run dropped before its first job, and whether it was quarantined too. */
export type DroppedDevice = { reason: string; quarantined: boolean };

export type WarmAdmitDeps = {
	warm: Pick<EarlyWarm, "device">;
	/** quarantine the device behind `udid` (its lease, warden devices only); true when it was */
	quarantine: (udid: string, reason: string) => boolean;
	/** an error line for the terminal */
	report: (line: string) => void;
	/** every device dropped so far, by udid (the report reads it) */
	dropped: Map<string, DroppedDevice>;
};

/**
 * The scheduler's `admit` for a warmed iOS run: a worker waits for its own device's warm-up (as its first job's
 * socket lookup would) and leaves before pulling a job when `axVerdict` drops it; a quarantined device is never
 * handed out again. Never throws (a failed quarantine still drops the device).
 */
export function warmAdmit(deps: WarmAdmitDeps): (worker: BatchWorker) => Promise<boolean> {
	return async ({ udid }) => {
		const verdict = axVerdict(await deps.warm.device(udid));
		if (verdict.kind === "keep") return true;
		let quarantined = false;
		if (verdict.kind === "quarantine") {
			try {
				quarantined = deps.quarantine(udid, verdict.reason);
			} catch {
				quarantined = false;
			}
		}
		deps.dropped.set(udid, { reason: verdict.reason, quarantined });
		const why = quarantined ? `dropped and quarantined (clear with: warden sim unquarantine ${udid})` : "dropped";
		deps.report(`${udid}: ${verdict.reason}; ${why}`);
		return false;
	};
}
