import type { HostFault } from "../conditions/conditions.types";
import type { ProxyEvent } from "./proxy";
import { delayMs, faultFor, type ProxyConditions, type Rng } from "./shaping";

/** What to do with one request once its target host is known. */
export type Verdict = {
	act: { kind: "reset" } | { kind: "hold" } | { kind: "status"; code: number } | { kind: "go" };
	/** delay before the act: params latency (+ a `delay` fault) */
	waitMs: number;
	event?: ProxyEvent;
	/** which counter to bump */
	count?: "faulted" | "resets";
};

function faultVerdict(fault: HostFault, host: string, isConnect: boolean, waitMs: number): Verdict {
	const { action } = fault;
	const event = (note?: "https-status-as-reset"): ProxyEvent => ({
		kind: "fault",
		host,
		action: action.kind,
		...(note ? { note } : {}),
	});
	switch (action.kind) {
		case "status":
			if (isConnect)
				return { act: { kind: "reset" }, waitMs: 0, count: "faulted", event: event("https-status-as-reset") };
			return { act: { kind: "status", code: action.code }, waitMs, count: "faulted", event: event() };
		case "reset":
			return { act: { kind: "reset" }, waitMs: 0, count: "faulted", event: event() };
		case "blackhole":
			return { act: { kind: "hold" }, waitMs: 0, count: "faulted", event: event() };
		case "delay":
			return { act: { kind: "go" }, waitMs: waitMs + action.ms, count: "faulted", event: event() };
	}
}

/** Faults first (first glob match wins), then connection loss, then plain latency. */
export function decide(conditions: ProxyConditions, host: string, isConnect: boolean, rng: Rng): Verdict {
	const { params, faults } = conditions;
	const waitMs = delayMs(params, rng);
	const fault = faultFor(faults, host);
	if (fault) {
		const verdict = faultVerdict(fault, host, isConnect, waitMs);
		if (verdict.act.kind !== "go") return verdict;
	}
	const lossPct = params.lossPct ?? 0;
	if (lossPct > 0 && rng() * 100 < lossPct) {
		const outcome = rng() < 0.5 ? "reset" : "stall";
		const event: ProxyEvent = { kind: "loss", outcome, host };
		return outcome === "reset"
			? { act: { kind: "reset" }, waitMs: 0, event, count: "resets" }
			: { act: { kind: "hold" }, waitMs: 0, event };
	}
	if (fault?.action.kind === "delay") return faultVerdict(fault, host, isConnect, waitMs);
	return { act: { kind: "go" }, waitMs };
}
