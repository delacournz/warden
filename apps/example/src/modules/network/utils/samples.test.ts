import { describe, expect, test } from "bun:test";
import { barHeight, countText, describeFailure, lastText, median, p50Text, pushSample, type Sample } from "./samples";

const ok = (id: number, ms: number): Sample => ({ id, at: id * 1500, ok: true, ms, status: 200 });
const bad = (id: number, reason: "reset" | "offline" | "timeout"): Sample => ({
	id,
	at: id * 1500,
	ok: false,
	ms: 12,
	reason,
});

describe("median", () => {
	test("middle of an odd list, mean of the middle two of an even one", () => {
		expect(median([30, 10, 20])).toBe(20);
		expect(median([10, 20, 30, 40])).toBe(25);
	});
	test("null for nothing", () => {
		expect(median([])).toBeNull();
	});
});

describe("pushSample", () => {
	test("appends newest last and keeps only the latest `max`", () => {
		let buffer: readonly Sample[] = [];
		for (let i = 1; i <= 30; i++) buffer = pushSample(buffer, ok(i, 40), 24);
		expect(buffer).toHaveLength(24);
		expect(buffer[0]?.id).toBe(7);
		expect(buffer.at(-1)?.id).toBe(30);
	});
	test("does not mutate the input", () => {
		const before: readonly Sample[] = [ok(1, 40)];
		pushSample(before, ok(2, 40), 24);
		expect(before).toHaveLength(1);
	});
});

describe("describeFailure", () => {
	test("a timeout and an HTTP status keep their own words", () => {
		expect(describeFailure("Timed out", null, true)).toBe("timeout");
		expect(describeFailure("HTTP 503", 503, true)).toBe("http 503");
	});
	test("a network error is offline when the link is down, a reset when it is up", () => {
		expect(describeFailure("Network request failed", null, false)).toBe("offline");
		expect(describeFailure("Network request failed", null, true)).toBe("reset");
	});
});

describe("barHeight", () => {
	test("log scale: faster is shorter, clamped to the floor and the ceiling", () => {
		expect(barHeight(1, 40)).toBe(4);
		expect(barHeight(100_000, 40)).toBe(40);
		expect(barHeight(50, 40)).toBeLessThan(barHeight(500, 40));
		expect(barHeight(500, 40)).toBeLessThan(barHeight(2000, 40));
	});
});

describe("readout text", () => {
	test("last", () => {
		expect(lastText(undefined)).toBe("-");
		expect(lastText(ok(1, 48))).toBe("200 · 48 ms");
		expect(lastText(bad(2, "offline"))).toBe("failed · offline");
	});
	test("p50 is the median latency of the landed requests, in ms or s", () => {
		expect(p50Text([])).toBe("-");
		expect(p50Text([bad(1, "reset")])).toBe("-");
		expect(p50Text([ok(1, 40), ok(2, 60), bad(3, "reset")])).toBe("50 ms");
		expect(p50Text([ok(1, 1900)])).toBe("1.9 s");
	});
	test("count", () => {
		expect(countText({ ok: 12, failed: 3 })).toBe("12 ok · 3 failed");
	});
});
