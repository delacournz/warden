import { describe, expect, test } from "bun:test";
import { readStatusOf, saveStatusOf } from "./keychain-status";

describe("keychain status", () => {
	test("a read's OSStatus is the word the spec asserts", () => {
		expect(readStatusOf(0)).toBe("Read");
		expect(readStatusOf(-128)).toBe("Cancelled");
		expect(readStatusOf(-25308)).toBe("Needs UI");
		expect(readStatusOf(-25300)).toBe("Invalidated");
		expect(readStatusOf(-25293)).toBe("Failed");
		expect(readStatusOf(-34018)).toBe("Failed");
	});

	test("a save is Saved only on errSecSuccess", () => {
		expect(saveStatusOf(0)).toBe("Saved");
		expect(saveStatusOf(-50)).toBe("Failed");
	});
});
