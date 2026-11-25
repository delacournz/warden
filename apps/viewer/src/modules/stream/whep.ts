/** Pure helpers for the WHEP client. */

const MAX_BACKOFF_MS = 15_000;

/** Reconnect delay for the nth consecutive failure: 1s, doubling, capped at 15s. */
export function backoffDelay(attempt: number): number {
	return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt));
}

type IceGatherer = Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
	readonly iceGatheringState: RTCIceGatheringState;
};

/**
 * Wait until the peer connection has gathered every local ICE candidate, so the offer can carry
 * them all (non-trickle WHEP: Revyl's realtime bridge answers PATCH trickle with 400). Gives up
 * after `timeoutMs`, sending whatever was gathered, so one slow STUN server cannot stall the offer.
 */
export function iceGatheringComplete(pc: IceGatherer, timeoutMs: number): Promise<"complete" | "timeout"> {
	if (pc.iceGatheringState === "complete") return Promise.resolve("complete");
	return new Promise((resolve) => {
		const onChange = () => {
			if (pc.iceGatheringState !== "complete") return;
			clearTimeout(timer);
			pc.removeEventListener("icegatheringstatechange", onChange);
			resolve("complete");
		};
		const timer = setTimeout(() => {
			pc.removeEventListener("icegatheringstatechange", onChange);
			resolve("timeout");
		}, timeoutMs);
		pc.addEventListener("icegatheringstatechange", onChange);
	});
}
