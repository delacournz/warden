import { describe, expect, test } from "bun:test";
import { actionAvailability } from "./availability.ts";

describe("actionAvailability", () => {
	test("a live stream enables the session actions", () => {
		expect(actionAvailability("streaming", false)).toEqual({ enabled: true, reason: null });
	});

	test("every other state disables them with a reason", () => {
		expect(actionAvailability("expired", false)).toEqual({
			enabled: false,
			reason: "Access expired. Run warden view again.",
		});
		expect(actionAvailability("connecting", false)).toEqual({ enabled: false, reason: "Waiting for the stream." });
		expect(actionAvailability("reconnecting", false)).toEqual({
			enabled: false,
			reason: "The stream is reconnecting.",
		});
	});

	test("unreachable outranks reconnecting", () => {
		expect(actionAvailability("reconnecting", true).reason).toBe("Can't reach warden cloud.");
		expect(actionAvailability("connecting", true).reason).toBe("Can't reach warden cloud.");
	});

	test("expired outranks unreachable", () => {
		expect(actionAvailability("expired", true).reason).toBe("Access expired. Run warden view again.");
	});
});
