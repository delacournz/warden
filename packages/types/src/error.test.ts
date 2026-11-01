import { describe, expect, test } from "bun:test";
import { isWardenError, WARDEN_ERROR_CODES, wardenErr } from "./error";

describe("wardenErr", () => {
	test("builds a failed result with just code + message", () => {
		expect(wardenErr("probe_timeout", "slow")).toEqual({
			success: false,
			error: { code: "probe_timeout", message: "slow" },
		});
	});

	test("carries hint, details and retryable only when given", () => {
		const res = wardenErr("device_busy", "busy", { hint: "wait", details: { id: "U1" }, retryable: true });
		expect(res.error).toEqual({
			code: "device_busy",
			message: "busy",
			hint: "wait",
			details: { id: "U1" },
			retryable: true,
		});
	});
});

describe("isWardenError", () => {
	test("accepts a coded error", () => {
		expect(isWardenError({ code: "claim_aborted", message: "x" })).toBe(true);
	});

	test("rejects strings, unknown codes and missing messages", () => {
		expect(isWardenError("claim aborted")).toBe(false);
		expect(isWardenError(null)).toBe(false);
		expect(isWardenError({ code: "nope", message: "x" })).toBe(false);
		expect(isWardenError({ code: "failed" })).toBe(false);
	});

	test("every seeded code is accepted", () => {
		for (const code of WARDEN_ERROR_CODES) expect(isWardenError({ code, message: "m" })).toBe(true);
	});

	test("includes the SDK codes", () => {
		for (const code of ["claim_aborted", "probe_timeout", "capacity_exhausted", "store_incompatible", "timeout"]) {
			expect(WARDEN_ERROR_CODES.some((c) => c === code)).toBe(true);
		}
	});
});
