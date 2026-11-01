/**
 * Events of the docs (`build-an-integration.mdx`): subscribe by kind, narrow on `kind`, unsubscribe.
 */
import { createWardenClient, type WardenEvent } from "../src/index";

/** One log line per event; a `switch` on `kind` narrows each variant. */
export function describeEvent(event: WardenEvent): string {
	switch (event.kind) {
		case "lease:claimed":
			return `claimed ${event.lease.id}`;
		case "lease:released":
			return `released ${event.leaseId}`;
		case "device:booted":
			return `booted ${event.platform} ${event.deviceId}`;
		case "session:opened":
		case "session:closed":
			return `${event.kind} ${event.sessionId}`;
		case "action":
			return `${event.op} ${event.ok ? "ok" : "failed"} in ${event.ms}ms`;
		case "progress":
		case "warn":
		case "debug":
			return `${event.kind}: ${event.message}`;
	}
}

export async function traceActions(): Promise<number> {
	let slow = 0;
	await using warden = createWardenClient({ onEvent: (event) => console.error(describeEvent(event)) });
	const stop = warden.on("action", (event) => {
		if (event.ms > 1000) slow++;
	});
	await warden.devices.list();
	stop();
	return slow;
}
