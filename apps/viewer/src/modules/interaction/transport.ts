export type Transport = "live" | "http";

/**
 * Which path carries an action. A gesture already in flight keeps the path it started on (`pinned`),
 * so a socket that drops mid-press never splits one touch across both; otherwise live when the
 * input socket is ready, HTTP when it is not.
 */
export function selectTransport(ready: boolean, pinned?: Transport | null): Transport {
	if (pinned) return pinned;
	return ready ? "live" : "http";
}
