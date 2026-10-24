import { describe, expect, test } from "bun:test";
import {
	AGING_MS,
	effectivePriority,
	isHead,
	PRIORITY,
	PRIORITY_STEP,
	parsePriority,
	queueOrder,
	queuePosition,
} from "./queue";
import type { QueueEntry } from "./types";

const entry = (id: string, priority: number, enqueuedAt: number): QueueEntry => ({
	id,
	platform: "ios",
	profile: "iphone-17",
	units: 1,
	priority,
	enqueuedAt,
	heartbeatAt: enqueuedAt,
	owner: { kind: "ci", runId: id },
});

describe("parsePriority", () => {
	test("names map to numbers", () => {
		expect(parsePriority("interactive")).toEqual({ success: true, data: 30 });
		expect(parsePriority("High")).toEqual({ success: true, data: 20 });
		expect(PRIORITY).toEqual({ interactive: 30, high: 20, normal: 10, low: 0 });
	});
	test("non-negative integers are taken as-is", () => {
		expect(parsePriority("25")).toEqual({ success: true, data: 25 });
		expect(parsePriority(" 0 ")).toEqual({ success: true, data: 0 });
		expect(parsePriority("-1").success).toBe(false);
		expect(parsePriority("1.5").success).toBe(false);
	});
	test("unknown is an error", () => {
		expect(parsePriority("urgent").success).toBe(false);
		expect(parsePriority("toString").success).toBe(false);
	});
});

describe("ordering", () => {
	test("higher priority first, then fifo, then id", () => {
		const entries = [entry("c", 10, 5), entry("b", 10, 5), entry("a", 10, 9), entry("z", 20, 100)];
		expect(queueOrder(entries, 100).map((e) => e.id)).toEqual(["z", "b", "c", "a"]);
	});
	test("aging adds one priority level per 10 minutes", () => {
		expect(effectivePriority(entry("a", 0, 0), 25 * 60_000)).toBe(2 * PRIORITY_STEP);
		expect(effectivePriority(entry("a", 0, 100), 0)).toBe(0);
	});
	test("an aged low row overtakes a fresh normal one", () => {
		const low = entry("low", PRIORITY.low, 0);
		const normal = entry("normal", PRIORITY.normal, 99 * 60_000);
		const now = 100 * 60_000;
		expect(isHead([low, normal], "low", now)).toBe(true);
		expect(isHead([low, normal], "low", AGING_MS - 1)).toBe(false);
	});
	test("a low row waiting 20 min overtakes a fresh high one, inside the 30 min default wait", () => {
		const low = entry("low", PRIORITY.low, 0);
		const high = entry("high", PRIORITY.high, 20 * 60_000);
		expect(isHead([low, high], "low", 20 * 60_000 - 1)).toBe(false);
		expect(isHead([low, high], "low", 20 * 60_000)).toBe(true);
	});
	test("position + isHead", () => {
		const entries = [entry("a", 0, 1), entry("b", 10, 2)];
		expect(queuePosition(entries, "b", 3)).toBe(1);
		expect(queuePosition(entries, "a", 3)).toBe(2);
		expect(queuePosition(entries, "nope", 3)).toBeUndefined();
		expect(isHead(entries, "nope", 3)).toBe(false);
	});
});
