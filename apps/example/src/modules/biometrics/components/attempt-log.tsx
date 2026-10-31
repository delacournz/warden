import { EventLog, type LogLine } from "@/modules/showcase/components/event-log";
import type { BiometricEvent } from "../hooks/use-biometric-unlock";

function lineOf(event: BiometricEvent): LogLine {
	const { at } = event;
	switch (event.kind) {
		case "requested":
			return { at, text: "face id requested", tone: "scan" };
		case "unlocked":
			return { at, text: `matched · ${event.tookMs} ms`, tone: "open" };
		case "cancelled":
			return { at, text: `prompt ${event.error}`, tone: "warn" };
		case "failed":
			return { at, text: `rejected · ${event.error}`, tone: "warn" };
		case "not-enrolled":
			return { at, text: "no face enrolled", tone: "off" };
		case "locked":
			return { at, text: "vault locked", tone: "idle" };
	}
}

/** Newest-first log of unlock attempts (`EventLog`). */
export function AttemptLog({ events }: { events: readonly BiometricEvent[] }) {
	return <EventLog empty="no attempts yet" lines={events.map(lineOf)} />;
}
