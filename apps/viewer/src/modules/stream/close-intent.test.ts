import { describe, expect, test } from "bun:test";
import { asksOnClose } from "./close-intent.ts";

describe("asksOnClose", () => {
	test("an attached viewer on a live device asks keep or shut down", () => {
		expect(asksOnClose({ detached: false, scope: "drive", overlay: null })).toBe(true);
		expect(asksOnClose({ detached: false, scope: "view", overlay: null })).toBe(true);
	});

	test("a detached drive viewer asks too: it can stop the device itself", () => {
		expect(asksOnClose({ detached: true, scope: "drive", overlay: null })).toBe(true);
	});

	test("a detached view viewer just closes: its token cannot stop the device", () => {
		expect(asksOnClose({ detached: true, scope: "view", overlay: null })).toBe(false);
	});

	test("a stopped or expired device has nothing left to keep running", () => {
		for (const overlay of ["stopped", "out-of-credits", "expired"] as const) {
			expect(asksOnClose({ detached: false, scope: "drive", overlay })).toBe(false);
			expect(asksOnClose({ detached: true, scope: "drive", overlay })).toBe(false);
		}
	});
});
