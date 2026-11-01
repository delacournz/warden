import { describe, expect, test } from "bun:test";
import type { QueueEntry } from "@delacour/warden-store/types";
import { AGING_MS, PRIORITY, PRIORITY_STEP, queueOrdering } from "./queue";

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
		expect(queueOrdering.parsePriority("interactive")).toEqual({ success: true, data: 30 });
		expect(queueOrdering.parsePriority("High")).toEqual({ success: true, data: 20 });
		expect(PRIORITY).toEqual({ interactive: 30, high: 20, normal: 10, low: 0 });
	});
	test("non-negative integers are taken as-is", () => {
		expect(queueOrdering.parsePriority("25")).toEqual({ success: true, data: 25 });
		expect(queueOrdering.parsePriority(" 0 ")).toEqual({ success: true, data: 0 });
		expect(queueOrdering.parsePriority("-1").success).toBe(false);
		expect(queueOrdering.parsePriority("1.5").success).toBe(false);
	});
	test("unknown is an error", () => {
		expect(queueOrdering.parsePriority("urgent").success).toBe(false);
		expect(queueOrdering.parsePriority("toString").success).toBe(false);
	});
});

describe("ordering", () => {
	test("higher priority first, then fifo, then id", () => {
		const entries = [entry("c", 10, 5), entry("b", 10, 5), entry("a", 10, 9), entry("z", 20, 100)];
		expect(queueOrdering.order(entries, 100).map((e) => e.id)).toEqual(["z", "b", "c", "a"]);
	});
	test("aging adds one priority level per 10 minutes", () => {
		expect(queueOrdering.effectivePriority(entry("a", 0, 0), 25 * 60_000)).toBe(2 * PRIORITY_STEP);
		expect(queueOrdering.effectivePriority(entry("a", 0, 100), 0)).toBe(0);
	});
	test("an aged low row overtakes a fresh normal one", () => {
		const low = entry("low", PRIORITY.low, 0);
		const normal = entry("normal", PRIORITY.normal, 99 * 60_000);
		const now = 100 * 60_000;
		expect(queueOrdering.isHead([low, normal], "low", now)).toBe(true);
		expect(queueOrdering.isHead([low, normal], "low", AGING_MS - 1)).toBe(false);
	});
	test("a low row waiting 20 min overtakes a fresh high one, inside the 30 min default wait", () => {
		const low = entry("low", PRIORITY.low, 0);
		const high = entry("high", PRIORITY.high, 20 * 60_000);
		expect(queueOrdering.isHead([low, high], "low", 20 * 60_000 - 1)).toBe(false);
		expect(queueOrdering.isHead([low, high], "low", 20 * 60_000)).toBe(true);
	});
	test("position + isHead", () => {
		const entries = [entry("a", 0, 1), entry("b", 10, 2)];
		expect(queueOrdering.position(entries, "b", 3)).toBe(1);
		expect(queueOrdering.position(entries, "a", 3)).toBe(2);
		expect(queueOrdering.position(entries, "nope", 3)).toBeUndefined();
		expect(queueOrdering.isHead(entries, "nope", 3)).toBe(false);
	});
});
