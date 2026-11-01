import { describe, expect, test } from "bun:test";
import { needsRefit } from "./window-fit.ts";

describe("needsRefit", () => {
	test("fits the first frame", () => {
		expect(needsRefit(null, 440 / 956)).toBe(true);
	});

	test("refits when the device rotates", () => {
		expect(needsRefit(440 / 956, 956 / 440)).toBe(true);
	});

	test("ignores a change under 1%", () => {
		expect(needsRefit(0.46, 0.462)).toBe(false);
	});

	test("ignores a bad aspect", () => {
		expect(needsRefit(null, 0)).toBe(false);
		expect(needsRefit(null, Number.NaN)).toBe(false);
		expect(needsRefit(null, Number.POSITIVE_INFINITY)).toBe(false);
	});
});
