import { describe, expect, test } from "bun:test";
import { cloudFailure } from "./errors";

describe("cloudFailure", () => {
	test("402 CREDITS_EXHAUSTED: out of credits, with the top-up link and a JSON code", () => {
		expect(
			cloudFailure({
				kind: "payment_required",
				code: "CREDITS_EXHAUSTED",
				message: "balance is 0",
				billingUrl: "https://app.warden.co.nz/billing",
			})
		).toEqual({
			code: "credits_exhausted",
			message: "remote claim failed: out of credits; top up at https://app.warden.co.nz/billing",
			billingUrl: "https://app.warden.co.nz/billing",
		});
	});

	test("402 without a link points at warden billing --top-up", () => {
		expect(cloudFailure({ kind: "payment_required", message: "pay up" })).toEqual({
			code: "credits_exhausted",
			message: "remote claim failed: out of credits; top up with: warden billing --top-up",
		});
	});

	test("403 MACHINE_REQUIRED_FOR_TRIAL explains the machine check", () => {
		const f = cloudFailure({ kind: "forbidden", code: "MACHINE_REQUIRED_FOR_TRIAL", message: "x" });
		expect(f.code).toBe("machine_required_for_trial");
		expect(f.message).toContain("free trial");
		expect(f.message).toContain("warden login");
		expect(f.message).toContain("warden billing --top-up");
	});

	test("403 BILLING_ROLE: only owners and admins top up", () => {
		const f = cloudFailure({ kind: "forbidden", code: "BILLING_ROLE", message: "x" });
		expect(f.code).toBe("billing_role");
		expect(f.message).toContain("owner or admin");
	});

	test("anything else keeps its message and gets no code", () => {
		expect(cloudFailure({ kind: "network", message: "ECONNREFUSED" })).toEqual({ message: "ECONNREFUSED" });
		expect(cloudFailure({ kind: "unauthorized", message: "no session" })).toEqual({
			message: "no session (session expired? run warden login)",
		});
	});
});
