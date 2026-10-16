import { describe, expect, test } from "bun:test";
import { matchesText, normalizeText } from "./text";

describe("normalizeText", () => {
	test("collapses whitespace runs and trims", () => {
		expect(normalizeText("  Sign \n\t in  ")).toBe("Sign in");
		expect(normalizeText("a  b")).toBe("a b");
	});
});

describe("matchesText", () => {
	test("string is a whole-text match after normalisation, case-sensitive", () => {
		expect(matchesText("  Sign   in ", "Sign in")).toBe(true);
		expect(matchesText("Sign in now", "Sign in")).toBe(false);
		expect(matchesText("sign in", "Sign in")).toBe(false);
	});

	test("exact:false is a case-insensitive substring", () => {
		expect(matchesText("Sign in now", "SIGN IN", { exact: false })).toBe(true);
		expect(matchesText("Sign in now", "sign out", { exact: false })).toBe(false);
	});

	test("exact:true behaves like the default", () => {
		expect(matchesText("Sign in now", "Sign in", { exact: true })).toBe(false);
	});

	test("regexp is applied as written to the normalised value", () => {
		expect(matchesText("Total:   42", /^Total: \d+$/)).toBe(true);
		expect(matchesText("total", /TOTAL/)).toBe(false);
		expect(matchesText("total", /TOTAL/i)).toBe(true);
	});

	test("regexp with g/y flags is not stateful", () => {
		const pattern = /ab/g;
		expect(matchesText("ab", pattern)).toBe(true);
		expect(matchesText("ab", pattern)).toBe(true);
		expect(pattern.lastIndex).toBe(0);
	});

	test("empty string only matches an empty value exactly", () => {
		expect(matchesText("", "")).toBe(true);
		expect(matchesText("x", "")).toBe(false);
	});
});
