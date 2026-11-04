import { describe, expect, test } from "bun:test";
import { CLAIM_ERRORS, type ClaimErrorCode, claimError, parseClaimError } from "./claim-errors";

describe("claim error table", () => {
	test("every code has a distinct exit code outside 0-4, 124 and 130", () => {
		const exits = Object.values(CLAIM_ERRORS).map((e) => e.exit);
		expect(new Set(exits).size).toBe(exits.length);
		for (const exit of exits) expect([0, 1, 2, 3, 4, 124, 130]).not.toContain(exit);
	});

	test("every code has a hint", () => {
		for (const entry of Object.values(CLAIM_ERRORS)) expect(entry.hint.length).toBeGreaterThan(10);
	});
});

describe("claimError / parseClaimError", () => {
	test("round-trips the code, message and capacity reason", () => {
		const message = claimError({ code: "NO_CAPACITY", capacityReason: "memory-pressure" }, "memory pressure warn");
		expect(parseClaimError(message)).toEqual({
			code: "NO_CAPACITY",
			capacityReason: "memory-pressure",
			message: "memory pressure warn",
			hint: CLAIM_ERRORS.NO_CAPACITY.hint,
			exit: CLAIM_ERRORS.NO_CAPACITY.exit,
		});
	});

	test.each<Exclude<ClaimErrorCode, "NO_CAPACITY">>([
		"QUEUE_TIMEOUT",
		"NO_DEVICE",
		"REQUESTER_LIMIT",
		"RUNTIME_MISSING",
		"HEALTH_FAILED",
		"LEASE_LOST",
	])("%s round-trips without a capacity reason", (code) => {
		const parsed = parseClaimError(claimError({ code }, "why"));
		expect(parsed).toEqual({ code, message: "why", hint: CLAIM_ERRORS[code].hint, exit: CLAIM_ERRORS[code].exit });
	});

	test("an uncoded message is undefined", () => {
		expect(parseClaimError("simctl boot failed")).toBeUndefined();
		expect(parseClaimError("NO_SUCH_CODE: x")).toBeUndefined();
	});
});
