import { describe, expect, test } from "bun:test";
import { DEVICE_TYPE_PER_CHAR_MS, TYPE_BASE_MS, TYPE_PER_CHAR_MS, TYPE_PER_REPEAT_MS, typeBudget } from "./type-budget";

describe("typeTextBudgetMs", () => {
	test("empty text is the base", () => {
		expect(typeBudget.typeText("")).toBe(TYPE_BASE_MS);
	});
	test("100 ms per character", () => {
		expect(typeBudget.typeText("abc")).toBe(TYPE_BASE_MS + 300);
	});
	test("200 ms more per repeated character", () => {
		expect(typeBudget.typeText("aab")).toBe(TYPE_BASE_MS + 300 + 200);
		expect(typeBudget.typeText("aaa")).toBe(TYPE_BASE_MS + 300 + 400);
		expect(typeBudget.typeText("abab")).toBe(TYPE_BASE_MS + 400);
	});
	test("leaves headroom over the helper's nominal cost on a slow host", () => {
		const nominalPerChar = 5 + 20;
		expect(TYPE_PER_CHAR_MS).toBeGreaterThanOrEqual(nominalPerChar * 3.5);
		expect(TYPE_PER_REPEAT_MS).toBeGreaterThanOrEqual(50 * 3.5);
	});
	test("counts code points, not UTF-16 units", () => {
		expect(typeBudget.typeText("😀😀")).toBe(TYPE_BASE_MS + 200 + 200);
	});
	test("grows with a long string", () => {
		expect(typeBudget.typeText("x".repeat(100))).toBeGreaterThan(typeBudget.typeText("x".repeat(10)));
	});
});

describe("deviceTypeTextBudgetMs", () => {
	test("allows one runner round trip per character on a real device", () => {
		expect(typeBudget.deviceTypeText("abc")).toBe(TYPE_BASE_MS + 3 * DEVICE_TYPE_PER_CHAR_MS);
		expect(typeBudget.deviceTypeText("😀")).toBe(TYPE_BASE_MS + DEVICE_TYPE_PER_CHAR_MS);
		expect(DEVICE_TYPE_PER_CHAR_MS).toBeGreaterThan(TYPE_PER_CHAR_MS);
	});
});
