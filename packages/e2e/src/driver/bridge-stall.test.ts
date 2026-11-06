import { describe, expect, test } from "bun:test";
import { bridgeStallFromSpan, formatBridgeStall, noteBridgeStall } from "./bridge-stall";
import { collectSpanDetail, type SpanDetail } from "./span-detail";

const stall = {
	stage: "read",
	readMs: 4012,
	deadlineMs: 4000,
	guestAgeMs: 31_200,
	cold: false,
	cooldownRemainingMs: 20_000,
	probes: 2,
};

describe("bridge stall diagnostics", () => {
	test("formats every known field on one line", () => {
		expect(formatBridgeStall(stall)).toBe(
			"stage read · read 4012 ms of a 4000 ms deadline · warm · guest 31.2 s old · cooldown 20.0 s left · 2 failed bridge reads in a row"
		);
	});

	test("leaves out what the helper did not know", () => {
		expect(formatBridgeStall({ stage: "connect", cold: true, probes: 0 })).toBe(
			"stage connect · cold (first read) · 0 failed bridge reads in a row"
		);
	});

	test("goes onto the span as scalars and comes back off it", async () => {
		const notes: SpanDetail = {};
		await collectSpanDetail(notes, async () => noteBridgeStall(stall));
		expect(notes).toEqual({
			stallStage: "read",
			stallReadMs: 4012,
			stallDeadlineMs: 4000,
			stallGuestAgeMs: 31_200,
			stallCold: false,
			stallCooldownMs: 20_000,
			stallProbes: 2,
		});
		expect(bridgeStallFromSpan(notes)).toEqual(stall);
	});

	test("a span without a stall has none", () => {
		expect(bridgeStallFromSpan({ backend: "axbridge" })).toBeUndefined();
		expect(bridgeStallFromSpan(undefined)).toBeUndefined();
	});
});
