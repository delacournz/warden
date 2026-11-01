import { describe, expect, test } from "bun:test";
import { requirementChecker } from "./requirements";

describe("missingRequirements", () => {
	test("a physical iPhone has no pinch and no multi-touch", () => {
		expect(requirementChecker.missing({ platform: "ios", deviceKind: "physical" }, ["pinch", "multiTouch"])).toEqual([
			"pinch",
			"multiTouch",
		]);
		expect(requirementChecker.missing({ platform: "ios", deviceKind: "physical" }, ["multiTouch"])).toEqual([
			"multiTouch",
		]);
	});
	test("a simulator, an emulator and an Android phone are decided by the driver at run time", () => {
		expect(requirementChecker.missing({ platform: "ios" }, ["pinch"])).toEqual([]);
		expect(requirementChecker.missing({ platform: "android", deviceKind: "physical" }, ["pinch"])).toEqual([]);
		expect(requirementChecker.missing({ platform: undefined }, ["pinch"])).toEqual([]);
	});
	test("no requirements, nothing missing", () => {
		expect(requirementChecker.missing({ platform: "ios", deviceKind: "physical" }, undefined)).toEqual([]);
		expect(requirementChecker.missing({ platform: "ios", deviceKind: "physical" }, [])).toEqual([]);
	});
});
