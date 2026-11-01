import { describe, expect, test } from "bun:test";
import { driverErrors } from "./errors";

describe("driverErrors.make", () => {
	test("retryable defaults per code", () => {
		expect(driverErrors.make("E_TIMEOUT", "slow").retryable).toBe(true);
		expect(driverErrors.make("E_BAD_REQUEST", "nope").retryable).toBe(false);
		expect(driverErrors.make("E_BAD_REQUEST", "nope", { retryable: true }).retryable).toBe(true);
	});

	test("detail only when given", () => {
		expect(driverErrors.make("E_IO", "x")).toEqual({ code: "E_IO", message: "x", retryable: false });
		expect(driverErrors.make("E_IO", "x", { detail: { a: 1 } }).detail).toEqual({ a: 1 });
	});

	test("driverErrors.err is a failed Result", () => {
		const result = driverErrors.err("E_NO_ELEMENT", "nothing at 1,2");
		expect(result.success).toBe(false);
		expect(driverErrors.describe(result.error)).toBe("E_NO_ELEMENT: nothing at 1,2");
	});
});
