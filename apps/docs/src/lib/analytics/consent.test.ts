import { describe, expect, test } from "bun:test";
import { parseConsent } from "./consent";

describe("parseConsent", () => {
	test("reads the two stored choices and nothing else", () => {
		expect(parseConsent("granted")).toBe("granted");
		expect(parseConsent("denied")).toBe("denied");
		expect(parseConsent(null)).toBeNull();
		expect(parseConsent("yes")).toBeNull();
	});
});
