/** Pure helpers for the WHEP client. */

export type IceCandidateInit = {
	candidate: string;
	sdpMid: string | null;
	usernameFragment: string | null;
};

const MAX_BACKOFF_MS = 15_000;

/** Reconnect delay for the nth consecutive failure: 1s, doubling, capped at 15s. */
export function backoffDelay(attempt: number): number {
	return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt));
}

function attribute(section: string, name: string): string | null {
	const match = new RegExp(`^a=${name}:(.+)$`, "m").exec(section);
	return match?.[1]?.trim() ?? null;
}

/**
 * Wrap one local ICE candidate as a `application/trickle-ice-sdpfrag` body (RFC 8840): the ICE
 * credentials, then the media section the candidate belongs to. Returns null for the end-of-candidates
 * marker or a mid the SDP does not contain.
 */
export function candidateFragment(candidate: IceCandidateInit, localSdp: string): string | null {
	if (candidate.candidate === "" || candidate.sdpMid === null) return null;
	const sections = localSdp.split(/\r?\nm=/).map((s, i) => (i === 0 ? s : `m=${s}`));
	const media = sections.slice(1).find((s) => attribute(s, "mid") === candidate.sdpMid);
	if (!media) return null;
	const kind = /^m=(\w+)/.exec(media)?.[1];
	const ufrag =
		candidate.usernameFragment ?? attribute(media, "ice-ufrag") ?? attribute(sections[0] ?? "", "ice-ufrag");
	const pwd = attribute(media, "ice-pwd") ?? attribute(sections[0] ?? "", "ice-pwd");
	if (!kind || !ufrag || !pwd) return null;
	const line = candidate.candidate.startsWith("a=") ? candidate.candidate : `a=${candidate.candidate}`;
	return [
		`a=ice-ufrag:${ufrag}`,
		`a=ice-pwd:${pwd}`,
		`m=${kind} 9 RTP/AVP 0`,
		`a=mid:${candidate.sdpMid}`,
		line,
		"",
	].join("\r\n");
}
