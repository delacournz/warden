import { describe, expect, test } from "bun:test";
import { demoDevice, rotated } from "./demo-device.ts";

describe("demoDevice", () => {
	test("is off when unset or empty", () => {
		expect(demoDevice(undefined)).toBeNull();
		expect(demoDevice("")).toBeNull();
	});

	test("resolves a preset to its pixel size", () => {
		expect(demoDevice("iphone-17-pro-max")).toEqual({ width: 1320, height: 2868 });
		expect(demoDevice("IPHONE-17")).toEqual({ width: 1206, height: 2622 });
	});

	test("takes an explicit WxH", () => {
		expect(demoDevice("1080x2400")).toEqual({ width: 1080, height: 2400 });
	});

	test("rejects anything else", () => {
		expect(demoDevice("nope")).toBeNull();
		expect(demoDevice("0x100")).toBeNull();
		expect(demoDevice("100x")).toBeNull();
	});
});

describe("rotated", () => {
	test("swaps width and height", () => {
		expect(rotated({ width: 1320, height: 2868 })).toEqual({ width: 2868, height: 1320 });
	});
});
