import { describe, expect, test } from "bun:test";
import { fallbackSlug, isValidOrgSlug, normalizeSlugInput, ORG_NAME_MAX, slugBase, validateOrgName } from "./org-slug";

describe("org slugs (mirror warden-web)", () => {
	test("slugBase: lower-case dash runs, ≤ 40, trimmed dashes", () => {
		expect(slugBase("Acme Mobile")).toBe("acme-mobile");
		expect(slugBase("  --Hello__World!! ")).toBe("hello-world");
		expect(slugBase("日本")).toBe("");
		expect(slugBase(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
	});

	test("isValidOrgSlug: 3–48, no leading/trailing/double dash", () => {
		for (const ok of ["acme", "one", "a1-b2", "a".repeat(48)]) expect(isValidOrgSlug(ok)).toBe(true);
		for (const bad of ["ab", "-acme", "acme-", "ac--me", "Acme", "a".repeat(49), "ac_me"]) {
			expect(isValidOrgSlug(bad)).toBe(false);
		}
	});

	test("fallbackSlug: base (or org) plus 6 hex", () => {
		const bytes = () => new Uint8Array([0xab, 0x01, 0xff]);
		expect(fallbackSlug("Acme", bytes)).toBe("acme-ab01ff");
		expect(fallbackSlug("!!", bytes)).toBe("org-ab01ff");
	});

	test("normalizeSlugInput: trims, lower-cases, spaces/underscores to dashes", () => {
		expect(normalizeSlugInput("  My_Org Name ")).toBe("my-org-name");
	});

	test("validateOrgName: 1–80 once trimmed", () => {
		expect(validateOrgName("Acme")).toBeUndefined();
		expect(validateOrgName("   ")).toContain("name");
		expect(validateOrgName("x".repeat(ORG_NAME_MAX + 1))).toContain(`${ORG_NAME_MAX}`);
	});
});
