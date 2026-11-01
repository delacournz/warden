import { describe, expect, test } from "bun:test";
import { opErrors } from "./driver";
import { exitCodeFor } from "./output";

describe("opErrors.driverError", () => {
	test("a locked phone is device_locked (exit 2), not a broken engine", () => {
		const error = opErrors.driverError({ code: "E_DEVICE_LOCKED", message: "the phone is locked", retryable: false });
		expect(error.code).toBe("device_locked");
		expect(error.hint).toContain("unlock");
		expect(exitCodeFor(error)).toBe(2);
	});

	test("a missing helper stays engine_unavailable (exit 3)", () => {
		const error = opErrors.driverError({ code: "E_HELPER_MISSING", message: "no helper", retryable: false });
		expect(error.code).toBe("engine_unavailable");
		expect(exitCodeFor(error)).toBe(3);
	});
});
