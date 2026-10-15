import { describe, expect, test } from "bun:test";
import { TYPE_BASE_MS, typeTextBudgetMs } from "./type-budget";

describe("typeTextBudgetMs", () => {
	test("empty text is the base", () => {
		expect(typeTextBudgetMs("")).toBe(TYPE_BASE_MS);
	});
	test("70 ms per character", () => {
		expect(typeTextBudgetMs("abc")).toBe(TYPE_BASE_MS + 210);
	});
	test("300 ms more per repeated character", () => {
		expect(typeTextBudgetMs("aab")).toBe(TYPE_BASE_MS + 210 + 300);
		expect(typeTextBudgetMs("aaa")).toBe(TYPE_BASE_MS + 210 + 600);
		expect(typeTextBudgetMs("abab")).toBe(TYPE_BASE_MS + 280);
	});
	test("counts code points, not UTF-16 units", () => {
		expect(typeTextBudgetMs("😀😀")).toBe(TYPE_BASE_MS + 140 + 300);
	});
	test("grows with a long string", () => {
		expect(typeTextBudgetMs("x".repeat(100))).toBeGreaterThan(typeTextBudgetMs("x".repeat(10)));
	});
});
