import type { DeviceWarm } from "./early-warm";

/**
 * What a run does with a device after its warm-up: `keep` it (warm, or cold for a reason that is not a wedge: its
 * jobs run cold as before), `drop` it from the run, or `quarantine` it (drop it and mark it bad, so no claim hands
 * it out again until `warden sim unquarantine`).
 */
export type AxVerdict = { kind: "keep" } | { kind: "drop"; reason: string } | { kind: "quarantine"; reason: string };

const KEEP: AxVerdict = { kind: "keep" };

/**
 * Reads that time out, the only sign of a wedge (the warm-up's own rule): the sim log can carry the wedge marker on
 * a sim that still answers, so a device that ended cold on a fast failure is no verdict.
 */
const TIMED_OUT = /E_TIMEOUT|did not answer within/;

/**
 * A device whose accessibility service was found wedged (`axRecovery`) and that still ended its warm-up cold: every
 * read on it times out for the life of that boot, so its specs could only fail. Only when its last read timed out too
 * (`TIMED_OUT`): one that failed fast still answers and runs cold, as before. A recovery outcome this build does
 * not know (a newer warm-up) is read conservatively: dropped from this run, never quarantined. An interrupted
 * warm-up is no verdict.
 */
export function axVerdict(done: Pick<DeviceWarm, "socketPath" | "error" | "axRecovery">): AxVerdict {
	const record = done.axRecovery;
	const cold = done.error;
	if (done.socketPath !== undefined || !record || cold === undefined || !TIMED_OUT.test(cold)) return KEEP;
	const outcome: string = record.outcome;
	if (record.outcome === "failed")
		return { kind: "quarantine", reason: `accessibility service wedged, recovery failed: ${record.error}` };
	if (outcome === "recovered")
		return { kind: "quarantine", reason: `accessibility service wedged, still not answering after recovery: ${cold}` };
	return {
		kind: "drop",
		reason: `accessibility service wedged (recovery: ${outcome}), still not answering: ${cold}`,
	};
}
