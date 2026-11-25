import { describe, expect, test } from "bun:test";
import { plainText } from "@/components/rich-text";
import { PRICING, PRICING_SECTIONS } from "./pricing";
import { pricingRoute, termsRoute } from "./shared";

const EVERYTHING = plainText(JSON.stringify({ PRICING, PRICING_SECTIONS }));

describe("pricing", () => {
	test("states the rate, the trial and the top-up amounts", () => {
		expect(PRICING.ratePerMinuteUsd).toBe(0.2);
		expect(PRICING.trialUsd).toBe(2);
		expect(PRICING.topUpsUsd).toEqual([10, 20, 50]);
		expect(PRICING.topUpRangeUsd).toEqual({ min: 10, max: 500 });
		expect(EVERYTHING).toContain("$0.20");
		expect(EVERYTHING).toContain("$2");
		expect(EVERYTHING).toContain("per second");
		expect(EVERYTHING).toContain("never expire");
		expect(EVERYTHING).toContain("15% GST");
		expect(EVERYTHING).toContain("zero-rated");
		expect(EVERYTHING).toContain("30 days old");
	});

	test("names the billing commands and links the terms", () => {
		expect(EVERYTHING).toContain("warden billing --top-up");
		expect(EVERYTHING).toContain("warden whoami");
		expect(JSON.stringify(PRICING_SECTIONS)).toContain(`](${termsRoute})`);
	});

	test("keeps local simulators free", () => {
		expect(EVERYTHING).toContain("stay free");
	});

	test("has a distinct route", () => {
		expect(pricingRoute).toBe("/pricing");
	});
});
