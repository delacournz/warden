import { describe, expect, test } from "bun:test";
import { textMatcher } from "./text";

describe("normalizeText", () => {
	test("collapses whitespace runs and trims", () => {
		expect(textMatcher.normalizeText("  Sign \n\t in  ")).toBe("Sign in");
		expect(textMatcher.normalizeText("a  b")).toBe("a b");
	});
});

describe("matchesText", () => {
	test("string is a whole-text match after normalisation, case-sensitive", () => {
		expect(textMatcher.matchesText("  Sign   in ", "Sign in")).toBe(true);
		expect(textMatcher.matchesText("Sign in now", "Sign in")).toBe(false);
		expect(textMatcher.matchesText("sign in", "Sign in")).toBe(false);
	});

	test("exact:false is a case-insensitive substring", () => {
		expect(textMatcher.matchesText("Sign in now", "SIGN IN", { exact: false })).toBe(true);
		expect(textMatcher.matchesText("Sign in now", "sign out", { exact: false })).toBe(false);
	});

	test("exact:true behaves like the default", () => {
		expect(textMatcher.matchesText("Sign in now", "Sign in", { exact: true })).toBe(false);
	});

	test("regexp is applied as written to the normalised value", () => {
		expect(textMatcher.matchesText("Total:   42", /^Total: \d+$/)).toBe(true);
		expect(textMatcher.matchesText("total", /TOTAL/)).toBe(false);
		expect(textMatcher.matchesText("total", /TOTAL/i)).toBe(true);
	});

	test("regexp with g/y flags is not stateful", () => {
		const pattern = /ab/g;
		expect(textMatcher.matchesText("ab", pattern)).toBe(true);
		expect(textMatcher.matchesText("ab", pattern)).toBe(true);
		expect(pattern.lastIndex).toBe(0);
	});

	test("empty string only matches an empty value exactly", () => {
		expect(textMatcher.matchesText("", "")).toBe(true);
		expect(textMatcher.matchesText("x", "")).toBe(false);
	});
});
