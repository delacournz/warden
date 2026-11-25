import { describe, expect, test } from "bun:test";
import { plainText } from "@/components/rich-text";
import { TERMS, TERMS_SECTIONS } from "./terms";

const EVERYTHING = plainText(JSON.stringify({ TERMS, TERMS_SECTIONS }));

describe("terms", () => {
	test("names the provider and the date", () => {
		expect(TERMS.provider).toBe("Delacour Limited");
		expect(TERMS.updated).toBe("2026-10-31");
		expect(Date.parse(TERMS.updated)).toBeLessThanOrEqual(Date.now());
	});

	test("covers each term that matters", () => {
		for (const phrase of [
			"New Zealand",
			"for business purposes",
			"Consumer Guarantees Act 1993 does not apply, to the extent permitted by law",
			"non-refundable",
			"never expire",
			"cryptocurrency",
			"one trial per person",
			"chargeback",
			"as is",
			"previous 3 months",
			"governed by New Zealand law",
		]) {
			expect(EVERYTHING).toContain(phrase);
		}
	});

	test("is not framed as legal advice and has no placeholder", () => {
		expect(EVERYTHING).not.toMatch(/legal advice/i);
		expect(EVERYTHING).not.toMatch(/\b(TODO|TBD|PLACEHOLDER|lorem|XXX)\b/i);
	});

	test("has unique kebab-case section ids", () => {
		const ids = TERMS_SECTIONS.map((section) => section.id);

		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
	});
});
