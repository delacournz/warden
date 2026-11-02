import { describe, expect, test } from "bun:test";
import { asksOnClose } from "./close-intent.ts";

describe("asksOnClose", () => {
	test("an attached viewer on a live device asks keep or shut down", () => {
		expect(asksOnClose(false, null)).toBe(true);
	});

	test("a detached viewer has no CLI to release the lease, so it just closes", () => {
		expect(asksOnClose(true, null)).toBe(false);
	});

	test("a stopped or expired device has nothing left to keep running", () => {
		expect(asksOnClose(false, "stopped")).toBe(false);
		expect(asksOnClose(false, "out-of-credits")).toBe(false);
		expect(asksOnClose(false, "expired")).toBe(false);
	});
});
