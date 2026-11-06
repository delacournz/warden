import { type BridgeStall, bridgeStallFromSpan } from "../driver/bridge-stall";
import type { TestResult } from "./results";
import type { TraceEvent } from "./trace";

export type BridgeEvidence = NonNullable<TestResult["bridge"]>;
type BridgeRead = BridgeEvidence["first"];

/**
 * Collects an attempt's iOS bridge fallbacks from its spans for `results.jsonl` (`bridge`): reads answered by `ax`
 * in place of `axbridge`, and failed reads that carried a stall report. A read the bridge answered by pid (frontmost
 * unresolved) is not one.
 */
export function bridgeEvidence(): { observe(event: TraceEvent): void; summary(): BridgeEvidence | undefined } {
	let fallbacks = 0;
	let first: BridgeRead | undefined;
	let last: BridgeRead | undefined;
	return {
		observe(event) {
			if (event.type !== "span" || event.detail === undefined) return;
			const detail = event.detail;
			const stall: BridgeStall | undefined = bridgeStallFromSpan(detail);
			const reason = typeof detail.fallback === "string" ? detail.fallback : undefined;
			const fellBack = reason !== undefined && detail.backend !== "axbridge";
			if (stall === undefined && !fellBack) return;
			const read: BridgeRead = {
				...(fellBack ? { reason } : {}),
				...(event.ok || event.code === undefined ? {} : { code: event.code }),
				...stall,
			};
			fallbacks += 1;
			first ??= read;
			last = read;
		},
		summary() {
			return first === undefined || last === undefined ? undefined : { fallbacks, first, last };
		},
	};
}
