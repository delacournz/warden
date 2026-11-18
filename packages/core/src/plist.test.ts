import { describe, expect, test } from "bun:test";
import { binaryPlistFlags, plistBool } from "./plist";
import { flagsPlist } from "./plist.testing";

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

describe("binaryPlistFlags", () => {
	test("reads the top-level booleans and integers of a binary plist, skipping everything else", () => {
		expect(binaryPlistFlags(flagsPlist())).toEqual(
			new Map<string, boolean | number>([
				["KeyboardAutocorrection", false],
				["KeyboardPrediction", true],
				["KeyboardCheckSpelling", 0],
				["CaféÜnïcode", true],
				["Big", 70000],
				["AutomationEnabled", 1],
			])
		);
	});

	test("an XML plist, a truncated file or garbage is not read (the caller asks plutil)", () => {
		expect(binaryPlistFlags(new TextEncoder().encode('<?xml version="1.0"?><plist><dict/></plist>'))).toBeUndefined();
		expect(binaryPlistFlags(flagsPlist().slice(0, 60))).toBeUndefined();
		expect(binaryPlistFlags(new Uint8Array(0))).toBeUndefined();
		const broken = flagsPlist();
		broken[broken.length - 9] = 0xff;
		expect(binaryPlistFlags(broken)).toBeUndefined();
	});
});
