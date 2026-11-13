import type { DeviceWarm } from "./early-warm";

/**
 * What a run does with a device after its warm-up: `keep` it (warm, or cold for a reason that is not a wedge: its
 * jobs run cold as before), `drop` it from the run, or `quarantine` it (drop it and mark it bad, so no claim hands
 * it out for 24h, or until `warden sim unquarantine`).
 */
export type AxVerdict = { kind: "keep" } | { kind: "drop"; reason: string } | { kind: "quarantine"; reason: string };

const KEEP: AxVerdict = { kind: "keep" };

/**
 * Reads that time out, the only sign of a wedge (the warm-up's own rule): the sim log can carry the wedge marker on
 * a sim that still answers, so a device that ended cold on a fast failure is no verdict.
 */
const TIMED_OUT = /E_TIMEOUT|did not answer within/;

/** The recovery outcomes this build knows that left the device still answering nothing: what was tried. */
const TRIED: Readonly<Record<string, string>> = { recovered: "recovery", rebooted: "a reboot" };

/**
 * A device whose accessibility service was found wedged (`axRecovery`) and that still ended its warm-up cold: every
 * read on it times out, so its specs could only fail (a restart of backboardd, even a reboot, did not clear it).
 * Only when its last read timed out too
 * (`TIMED_OUT`): one that failed fast still answers and runs cold, as before. A recovery outcome this build does
 * not know (a newer warm-up) is read conservatively: dropped from this run, never quarantined. An interrupted
 * warm-up is no verdict.
 */
export function axVerdict(done: Pick<DeviceWarm, "socketPath" | "error" | "axRecovery">): AxVerdict {
	const record = done.axRecovery;
	const cold = done.error;
	if (done.socketPath !== undefined || !record || cold === undefined || !TIMED_OUT.test(cold)) return KEEP;
	const outcome: string = record.outcome;
	if (record.outcome === "failed") {
		const stage = record.stage ? ` (${record.stage})` : "";
		return { kind: "quarantine", reason: `accessibility service wedged, recovery failed${stage}: ${record.error}` };
	}
	const tried = TRIED[outcome];
	if (tried !== undefined)
		return { kind: "quarantine", reason: `accessibility service wedged, still not answering after ${tried}: ${cold}` };
	return {
		kind: "drop",
		reason: `accessibility service wedged (recovery: ${outcome}), still not answering: ${cold}`,
	};
}
