import { describe, expect, test } from "bun:test";
import { bridgeEvidence } from "./bridge-evidence";
import { testResultSchema } from "./results";
import type { TraceEvent } from "./trace";

const span = (detail: Record<string, string | number | boolean>, ok = true, code?: string): TraceEvent => ({
	type: "span",
	ts: 1,
	op: "driver.snapshot",
	ms: 5,
	ok,
	...(code === undefined ? {} : { code }),
	detail,
});

const stalled = (probes: number, cold: boolean) => ({
	backend: "ax",
	fallback: "the axbridge guest did not answer within 4000 ms",
	stallStage: "read",
	stallReadMs: 4001,
	stallDeadlineMs: 4000,
	stallCold: cold,
	stallProbes: probes,
});

describe("bridgeEvidence", () => {
	test("nothing to say when every read was on the bridge", () => {
		const evidence = bridgeEvidence();
		evidence.observe(span({ backend: "axbridge" }));
		evidence.observe({ type: "note", ts: 1, kind: "x", label: "y" });
		expect(evidence.summary()).toBeUndefined();
	});

	test("counts the fallbacks and keeps the first and the last stall with their reason", () => {
		const evidence = bridgeEvidence();
		evidence.observe(span(stalled(1, true)));
		evidence.observe(span({ backend: "axbridge" }));
		evidence.observe(
			span({
				backend: "ax",
				fallback: "axbridge stalled 3 s ago",
				stallStage: "cooldown",
				stallCold: false,
				stallCooldownMs: 17_000,
				stallProbes: 2,
			})
		);
		expect(evidence.summary()).toEqual({
			fallbacks: 2,
			first: {
				reason: "the axbridge guest did not answer within 4000 ms",
				stage: "read",
				readMs: 4001,
				deadlineMs: 4000,
				cold: true,
				probes: 1,
			},
			last: {
				reason: "axbridge stalled 3 s ago",
				stage: "cooldown",
				cold: false,
				cooldownRemainingMs: 17_000,
				probes: 2,
			},
		});
	});

	test("a failed read that carried a stall counts too, with its error code", () => {
		const evidence = bridgeEvidence();
		evidence.observe(span({ stallStage: "read", stallCold: false, stallProbes: 3 }, false, "E_TIMEOUT"));
		expect(evidence.summary()).toEqual({
			fallbacks: 1,
			first: { code: "E_TIMEOUT", stage: "read", cold: false, probes: 3 },
			last: { code: "E_TIMEOUT", stage: "read", cold: false, probes: 3 },
		});
	});

	test("the recycles the helper had spent go into results.jsonl", () => {
		const evidence = bridgeEvidence();
		evidence.observe(span({ ...stalled(4, false), stallRecycles: 3, stallRecyclesExhausted: true }));
		const summary = evidence.summary();
		expect(summary?.last).toMatchObject({ recycles: 3, recyclesExhausted: true });
		expect(testResultSchema.shape.bridge.parse(summary)).toEqual(summary);
	});

	test("a fallback without a stall report (an older helper) still counts", () => {
		const evidence = bridgeEvidence();
		evidence.observe(span({ backend: "ax", fallback: "applicationUnavailable" }));
		expect(evidence.summary()).toEqual({
			fallbacks: 1,
			first: { reason: "applicationUnavailable" },
			last: { reason: "applicationUnavailable" },
		});
	});

	test("only snapshot-like reads count: a frontmost-by-pid read on the bridge is no bridge fallback", () => {
		const evidence = bridgeEvidence();
		evidence.observe(span({ backend: "axbridge", fallback: "frontmost unresolved; read pid 42", targetPid: 42 }));
		expect(evidence.summary()).toBeUndefined();
	});
});
