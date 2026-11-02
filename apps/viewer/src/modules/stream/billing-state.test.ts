import { describe, expect, test } from "bun:test";
import { type BillingState, initialBilling, overlayFor, reduceBilling } from "./billing-state.ts";

describe("reduceBilling", () => {
	test("starts quiet", () => {
		expect(initialBilling).toEqual({ lowBalance: false, stopped: null });
	});

	test("low balance toggles", () => {
		const low = reduceBilling(initialBilling, { type: "billing", lowBalance: true });
		expect(low.lowBalance).toBe(true);
		expect(reduceBilling(low, { type: "billing", lowBalance: false }).lowBalance).toBe(false);
	});

	test("stopping records the reason and clears low balance", () => {
		const low: BillingState = { lowBalance: true, stopped: null };
		expect(reduceBilling(low, { type: "stopped", reason: "credits_exhausted" })).toEqual({
			lowBalance: false,
			stopped: "credits_exhausted",
		});
	});

	test("a stop is final: later events change nothing", () => {
		const stopped = reduceBilling(initialBilling, { type: "stopped", reason: "idle" });
		expect(reduceBilling(stopped, { type: "billing", lowBalance: true })).toBe(stopped);
		expect(reduceBilling(stopped, { type: "stopped", reason: "credits_exhausted" })).toBe(stopped);
	});
});

describe("overlayFor", () => {
	test("expired access wins over everything", () => {
		expect(overlayFor(true, { lowBalance: false, stopped: "credits_exhausted" })).toBe("expired");
	});

	test("credits exhausted gets its own overlay", () => {
		expect(overlayFor(false, { lowBalance: false, stopped: "credits_exhausted" })).toBe("out-of-credits");
	});

	test("other stop reasons read as a stopped device", () => {
		for (const reason of ["user", "idle", "error", "unknown"] as const) {
			expect(overlayFor(false, { lowBalance: false, stopped: reason })).toBe("stopped");
		}
	});

	test("no overlay while running, low balance included", () => {
		expect(overlayFor(false, { lowBalance: true, stopped: null })).toBeNull();
	});
});
