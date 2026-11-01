import { describe, expect, test } from "bun:test";
import { LOCATION_PRESETS, parseLocation } from "./location.ts";

describe("parseLocation", () => {
	test("accepts valid coordinates", () => {
		expect(parseLocation("37.7749", " -122.4194 ")).toEqual({ latitude: 37.7749, longitude: -122.4194 });
	});
	test("rejects blanks, text and out-of-range values", () => {
		expect(parseLocation("", "10")).toBeNull();
		expect(parseLocation("abc", "10")).toBeNull();
		expect(parseLocation("91", "10")).toBeNull();
		expect(parseLocation("10", "-181")).toBeNull();
	});
	test("presets are all valid", () => {
		expect(LOCATION_PRESETS).toHaveLength(6);
		for (const p of LOCATION_PRESETS) expect(parseLocation(String(p.latitude), String(p.longitude))).not.toBeNull();
	});
});
