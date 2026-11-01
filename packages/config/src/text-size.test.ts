import { describe, expect, test } from "bun:test";
import { androidFontScale, appliedA11y, resolveTextSize } from "./text-size";

describe("resolveTextSize", () => {
	test("a name carries its scale", () => {
		const r = resolveTextSize("accessibility-large");
		expect(r.success && r.data).toEqual({ category: "accessibility-large", scale: 1.9 });
	});
	test("a scale picks the nearest category and is kept", () => {
		const r = resolveTextSize(1.3);
		expect(r.success && r.data).toEqual({ category: "extra-extra-extra-large", scale: 1.3 });
		const small = resolveTextSize(0.5);
		expect(small.success && small.data.category).toBe("extra-small");
	});
	test("rejects unknown names and non-positive scales", () => {
		expect(resolveTextSize("huge" as never).success).toBe(false);
		expect(resolveTextSize(0).success).toBe(false);
		expect(resolveTextSize(Number.NaN).success).toBe(false);
	});
});

describe("androidFontScale", () => {
	test("clamps to Android's range and rounds to 2 decimals", () => {
		expect(androidFontScale(3.1)).toBe(2);
		expect(androidFontScale(0.1)).toBe(0.5);
		expect(androidFontScale(1.3333)).toBe(1.33);
	});
});

describe("appliedA11y", () => {
	test("keeps only what the platform applied", () => {
		expect(
			appliedA11y({ textSize: 1.5, boldText: true, contrast: "increased" as const }, ["textSize", "contrast"])
		).toEqual({
			textSize: 1.5,
			contrast: "increased",
		});
	});
});
