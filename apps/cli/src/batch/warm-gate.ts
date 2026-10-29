import type { EarlyWarm } from "./early-warm";

/** The first device whose warm-up failed, with the classified code the run stops on. */
export type WarmGateFailure = { udid: string; code: string; message: string };

const CODED = /^([a-z][a-z0-9_]*): ([\s\S]*)$/;

/** A warm error as `code: message` (the shape `warm-connect` writes); an uncoded one is the generic `failed`. */
export function splitWarmError(error: string): { code: string; message: string } {
	const m = CODED.exec(error);
	return m?.[1] !== undefined && m[2] !== undefined
		? { code: m[1], message: m[2] }
		: { code: "failed", message: error };
}

/**
 * Devices that cannot run a job without their warm step (an iPhone's jobs reach its runner host only through the
 * warm socket): the first whose warm-up failed, or undefined when all are warm. Waits for each device's own
 * warm-up, never for the others'.
 */
export async function warmGate(
	udids: readonly string[],
	warm: Pick<EarlyWarm, "device">
): Promise<WarmGateFailure | undefined> {
	const outcomes = await Promise.all(udids.map(async (udid) => ({ udid, done: await warm.device(udid) })));
	for (const { udid, done } of outcomes) {
		if (done.socketPath !== undefined || (done.error === undefined && done.warning === undefined)) continue;
		const { code, message } =
			done.error !== undefined ? splitWarmError(done.error) : { code: "failed", message: done.warning ?? "" };
		return { udid, code, message };
	}
	return undefined;
}
