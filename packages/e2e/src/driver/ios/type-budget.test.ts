import { describe, expect, test } from "bun:test";
import {
	DEVICE_TYPE_PER_CHAR_MS,
	deviceTypeTextBudgetMs,
	QUICK_KEY_PACING,
	TYPE_BASE_MS,
	TYPE_PER_CHAR_MS,
	TYPE_PER_REPEAT_MS,
	typeTextBudgetMs,
} from "./type-budget";

describe("typeTextBudgetMs", () => {
	test("empty text is the base", () => {
		expect(typeTextBudgetMs("")).toBe(TYPE_BASE_MS);
	});
	test("100 ms per character", () => {
		expect(typeTextBudgetMs("abc")).toBe(TYPE_BASE_MS + 300);
	});
	test("200 ms more per repeated character", () => {
		expect(typeTextBudgetMs("aab")).toBe(TYPE_BASE_MS + 300 + 200);
		expect(typeTextBudgetMs("aaa")).toBe(TYPE_BASE_MS + 300 + 400);
		expect(typeTextBudgetMs("abab")).toBe(TYPE_BASE_MS + 400);
	});
	test("leaves headroom over the helper's nominal cost on a slow host", () => {
		const nominalPerChar = 5 + 20;
		expect(TYPE_PER_CHAR_MS).toBeGreaterThanOrEqual(nominalPerChar * 3.5);
		expect(TYPE_PER_REPEAT_MS).toBeGreaterThanOrEqual(50 * 3.5);
	});
	test("counts code points, not UTF-16 units", () => {
		expect(typeTextBudgetMs("😀😀")).toBe(TYPE_BASE_MS + 200 + 200);
	});
	test("grows with a long string", () => {
		expect(typeTextBudgetMs("x".repeat(100))).toBeGreaterThan(typeTextBudgetMs("x".repeat(10)));
	});
});

describe("deviceTypeTextBudgetMs", () => {
	test("allows one runner round trip per character on a real device", () => {
		expect(deviceTypeTextBudgetMs("abc")).toBe(TYPE_BASE_MS + 3 * DEVICE_TYPE_PER_CHAR_MS);
		expect(deviceTypeTextBudgetMs("😀")).toBe(TYPE_BASE_MS + DEVICE_TYPE_PER_CHAR_MS);
		expect(DEVICE_TYPE_PER_CHAR_MS).toBeGreaterThan(TYPE_PER_CHAR_MS);
	});
});

describe("QUICK_KEY_PACING", () => {
	test("is quicker than the helper's defaults and fits the per-character budget", () => {
		const { paceMs, holdMs, repeatGapMs, leadMs } = QUICK_KEY_PACING;
		expect(paceMs + holdMs).toBeLessThan(5 + 20);
		expect(repeatGapMs).toBeLessThan(50);
		expect(leadMs).toBe(60);
		expect(TYPE_PER_CHAR_MS).toBeGreaterThanOrEqual((paceMs + holdMs) * 3.5);
	});
});
