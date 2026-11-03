import { describe, expect, test } from "bun:test";
import { missingRequirements } from "./requirements";

describe("missingRequirements", () => {
	test("a physical iPhone has no pinch and no multi-touch", () => {
		expect(missingRequirements({ platform: "ios", deviceKind: "physical" }, ["pinch", "multiTouch"])).toEqual([
			"pinch",
			"multiTouch",
		]);
		expect(missingRequirements({ platform: "ios", deviceKind: "physical" }, ["multiTouch"])).toEqual(["multiTouch"]);
	});
	test("a simulator, an emulator and an Android phone are decided by the driver at run time", () => {
		expect(missingRequirements({ platform: "ios" }, ["pinch"])).toEqual([]);
		expect(missingRequirements({ platform: "android", deviceKind: "physical" }, ["pinch"])).toEqual([]);
		expect(missingRequirements({ platform: undefined }, ["pinch"])).toEqual([]);
	});
	test("no requirements, nothing missing", () => {
		expect(missingRequirements({ platform: "ios", deviceKind: "physical" }, undefined)).toEqual([]);
		expect(missingRequirements({ platform: "ios", deviceKind: "physical" }, [])).toEqual([]);
	});
});
