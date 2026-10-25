import { describe, expect, test } from "bun:test";
import { plainText } from "./rich-text";

describe("plainText", () => {
	test("strips the two marks and nothing else", () => {
		expect(plainText("Run `warden claim ios`, or read [the docs](https://warden.delacour.co.nz/docs).")).toBe(
			"Run warden claim ios, or read the docs."
		);
	});

	test("leaves a plain sentence alone", () => {
		expect(plainText("One lease. One owner.")).toBe("One lease. One owner.");
	});
});
