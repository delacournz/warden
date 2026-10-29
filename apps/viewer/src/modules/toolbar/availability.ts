import type { StreamStatus } from "../stream/whep-session.ts";

export type Availability = { enabled: true; reason: null } | { enabled: false; reason: string };

/**
 * Whether open-URL, screenshot and drive make sense right now. Only a live stream enables them;
 * otherwise `reason` says why, for the tooltip. Pin, minimize and close are never gated.
 */
export function actionAvailability(status: StreamStatus, unreachable: boolean): Availability {
	if (status === "streaming") return { enabled: true, reason: null };
	if (status === "expired") return { enabled: false, reason: "Access expired. Run warden view again." };
	if (unreachable) return { enabled: false, reason: "Can't reach warden cloud." };
	if (status === "reconnecting") return { enabled: false, reason: "The stream is reconnecting." };
	return { enabled: false, reason: "Waiting for the stream." };
}
