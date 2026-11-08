import { describe, expect, test } from "bun:test";
import { driverUiError } from "./driver";
import { exitCodeFor } from "./output";

describe("driverUiError", () => {
	test("a locked phone is device_locked (exit 2), not a broken engine", () => {
		const error = driverUiError({ code: "E_DEVICE_LOCKED", message: "the phone is locked", retryable: false });
		expect(error.code).toBe("device_locked");
		expect(error.hint).toContain("unlock");
		expect(exitCodeFor(error)).toBe(2);
	});

	test("a missing helper stays engine_unavailable (exit 3)", () => {
		const error = driverUiError({ code: "E_HELPER_MISSING", message: "no helper", retryable: false });
		expect(error.code).toBe("engine_unavailable");
		expect(exitCodeFor(error)).toBe(3);
	});
});
