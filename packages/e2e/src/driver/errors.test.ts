import { describe, expect, test } from "bun:test";
import { describeDriverError, driverErr, driverError } from "./errors";

describe("driverError", () => {
	test("retryable defaults per code", () => {
		expect(driverError("E_TIMEOUT", "slow").retryable).toBe(true);
		expect(driverError("E_BAD_REQUEST", "nope").retryable).toBe(false);
		expect(driverError("E_BAD_REQUEST", "nope", { retryable: true }).retryable).toBe(true);
	});

	test("detail only when given", () => {
		expect(driverError("E_IO", "x")).toEqual({ code: "E_IO", message: "x", retryable: false });
		expect(driverError("E_IO", "x", { detail: { a: 1 } }).detail).toEqual({ a: 1 });
	});

	test("driverErr is a failed Result", () => {
		const result = driverErr("E_NO_ELEMENT", "nothing at 1,2");
		expect(result.success).toBe(false);
		expect(describeDriverError(result.error)).toBe("E_NO_ELEMENT: nothing at 1,2");
	});
});
