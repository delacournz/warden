import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	ClockCondition,
	HostFault,
	LocationCondition,
	NetworkCondition,
} from "@delacour/warden-core/conditions/conditions.types";

/**
 * One applied condition transition, the evidence line that lets a failure show which network/location was
 * active. Written to `results.jsonl` beside the test results (`readResults` skips lines that are not a
 * `TestResult`, so the two kinds share the file).
 */
export type ConditionEvent =
	| { type: "condition"; area: "network"; value: NetworkCondition; at: number }
	| { type: "condition"; area: "location"; value: LocationCondition; at: number }
	| { type: "condition"; area: "clock"; value: ClockCondition; at: number }
	| { type: "condition"; area: "faults"; value: { kind: "faults"; rules: readonly HostFault[] }; at: number };

export type ConditionSink = (event: ConditionEvent) => void;

/** A sink that appends each event as one JSON line (`appendFileSync`: a crash never loses an earlier line). */
export function openConditionSink(path: string): ConditionSink {
	let ready = false;
	return (event) => {
		if (!ready) {
			mkdirSync(dirname(path), { recursive: true });
			ready = true;
		}
		appendFileSync(path, `${JSON.stringify(event)}\n`);
	};
}

function parseEvent(line: string): ConditionEvent | undefined {
	let json: unknown;
	try {
		json = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof json !== "object" || json === null) return undefined;
	const e = json as Record<string, unknown>;
	const known = e.area === "network" || e.area === "location" || e.area === "clock" || e.area === "faults";
	const shaped = e.type === "condition" && typeof e.at === "number" && typeof e.value === "object" && e.value !== null;
	return known && shaped ? (json as ConditionEvent) : undefined;
}

/** Condition events in file order; every other line (test results, blank, truncated) is skipped. */
export function readConditionEvents(text: string): ConditionEvent[] {
	return text
		.split("\n")
		.map(parseEvent)
		.filter((e): e is ConditionEvent => e !== undefined);
}

/** What was active per area at epoch ms `at`: the latest event at or before it. */
export function activeConditionsAt(
	events: readonly ConditionEvent[],
	at: number
): { network?: NetworkCondition; location?: LocationCondition; clock?: ClockCondition } {
	const active: { network?: NetworkCondition; location?: LocationCondition; clock?: ClockCondition } = {};
	let networkAt = Number.NEGATIVE_INFINITY;
	let locationAt = Number.NEGATIVE_INFINITY;
	let clockAt = Number.NEGATIVE_INFINITY;
	for (const e of events) {
		if (e.at > at) continue;
		if (e.area === "network" && e.at >= networkAt) {
			active.network = e.value;
			networkAt = e.at;
		} else if (e.area === "location" && e.at >= locationAt) {
			active.location = e.value;
			locationAt = e.at;
		} else if (e.area === "clock" && e.at >= clockAt) {
			active.clock = e.value;
			clockAt = e.at;
		}
	}
	return active;
}
