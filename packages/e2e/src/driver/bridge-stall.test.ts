import { describe, expect, test } from "bun:test";
import { bridgeStallFromSpan, formatBridgeStall, noteBridgeStall, toBridgeStall } from "./bridge-stall";
import { collectSpanDetail, type SpanDetail } from "./span-detail";

const stall = {
	stage: "read",
	readMs: 4012,
	deadlineMs: 4000,
	guestAgeMs: 31_200,
	cold: false,
	cooldownRemainingMs: 20_000,
	probes: 2,
	recycles: 3,
	recyclesExhausted: true,
};

describe("bridge stall diagnostics", () => {
	test("formats every known field on one line", () => {
		expect(formatBridgeStall(stall)).toBe(
			"stage read · read 4012 ms of a 4000 ms deadline · warm · guest 31.2 s old · cooldown 20.0 s left · 2 failed bridge reads in a row · 3 stalled guests recycled, none left"
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
			stallRecycles: 3,
			stallRecyclesExhausted: true,
		});
		expect(bridgeStallFromSpan(notes)).toEqual(stall);
	});

	test("names the recycles while some are left", () => {
		expect(formatBridgeStall({ stage: "read", cold: false, probes: 1, recycles: 1 })).toBe(
			"stage read · warm · 1 failed bridge reads in a row · 1 stalled guest recycled"
		);
	});

	test("keeps the recycle fields from the wire and drops unknown ones", () => {
		expect(
			toBridgeStall({ stage: "read", cold: false, probes: 1, recycles: 2, recyclesExhausted: false, later: 1 })
		).toEqual({ stage: "read", cold: false, probes: 1, recycles: 2, recyclesExhausted: false });
	});

	test("says the helper is checking for a wedged accessibility service, and how often it restarted it", async () => {
		const wedged = { stage: "warm-up", cold: true, probes: 3, axWedge: "checking", axWedgeRestarts: 1 };
		expect(formatBridgeStall(wedged)).toBe(
			"stage warm-up · cold (first read) · 3 failed bridge reads in a row · both readers silent: checking for a wedged accessibility service · backboardd restarted 1 time"
		);
		expect(toBridgeStall({ ...wedged, later: true })).toEqual(wedged);
		const notes: SpanDetail = {};
		await collectSpanDetail(notes, async () => noteBridgeStall(wedged));
		expect(notes.stallAxWedge).toBe("checking");
		expect(notes.stallAxWedgeRestarts).toBe(1);
		expect(bridgeStallFromSpan(notes)).toEqual(wedged);
	});

	test("a span without a stall has none", () => {
		expect(bridgeStallFromSpan({ backend: "axbridge" })).toBeUndefined();
		expect(bridgeStallFromSpan(undefined)).toBeUndefined();
	});
});
