import { EventLog, type LogLine } from "@/modules/showcase/components/event-log";
import type { PasskeyEvent } from "../hooks/use-passkey";
import { shortId } from "../utils/passkey-state";

function lineOf(event: PasskeyEvent): LogLine {
	const { at } = event;
	switch (event.kind) {
		case "create-requested":
			return { at, text: "create requested", tone: "scan" };
		case "saved":
			return { at, text: `saved ${shortId(event.credentialId)} · ${event.tookMs} ms`, tone: "idle" };
		case "sign-in-requested":
			return { at, text: "sign-in requested", tone: "scan" };
		case "signed-in":
			return {
				at,
				text: `signature valid · ${event.userVerified ? "uv" : "no uv"} · ${event.tookMs} ms`,
				tone: "open",
			};
		case "cancelled":
			return { at, text: `sheet ${event.error}`, tone: "warn" };
		case "failed":
			return { at, text: `failed · ${event.error}`, tone: "warn" };
		case "rejected":
			return { at, text: `rejected · ${event.reason} check`, tone: "warn" };
		case "signed-out":
			return { at, text: "signed out", tone: "idle" };
	}
}

/** Newest-first log of passkey calls (`EventLog`). */
export function PasskeyLog({ events }: { events: readonly PasskeyEvent[] }) {
	return <EventLog empty="no passkey calls yet" lines={events.map(lineOf)} testID="pk-log" />;
}
