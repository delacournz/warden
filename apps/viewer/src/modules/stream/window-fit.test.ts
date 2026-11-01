import { describe, expect, test } from "bun:test";
import { effectiveAspect, needsRefit } from "./window-fit.ts";

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

describe("effectiveAspect", () => {
	test("portrait keeps the stream aspect", () => {
		expect(effectiveAspect({ width: 1320, height: 2868 }, "portrait")).toBeCloseTo(1320 / 2868);
	});

	test("landscape inverts it, because the picture is shown rotated", () => {
		expect(effectiveAspect({ width: 1320, height: 2868 }, "landscape")).toBeCloseTo(2868 / 1320);
	});
});
