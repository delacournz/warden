import { describe, expect, test } from "bun:test";
import { plistBool } from "./plist";

describe("plistBool", () => {
	test("reads a plist boolean as plutil prints it", () => {
		expect(plistBool("true\n")).toBe(true);
		expect(plistBool("false\n")).toBe(false);
	});

	test("reads an integer flag (how the simulator stores AutomationEnabled)", () => {
		expect(plistBool("1\n")).toBe(true);
		expect(plistBool("0")).toBe(false);
	});

	test("anything else is unknown", () => {
		expect(plistBool("")).toBeUndefined();
		expect(plistBool("2")).toBeUndefined();
		expect(plistBool("YES")).toBeUndefined();
	});
});
