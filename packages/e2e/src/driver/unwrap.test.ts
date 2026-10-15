import { describe, expect, test } from "bun:test";
import { E2eError, type E2eErrorCode } from "../errors";
import type { DriverErrorCode, DriverResult } from "./driver.types";
import { driverErr } from "./errors";
import { settled, toE2eError, unwrap } from "./unwrap";

const ok = <T>(data: T): DriverResult<T> => Promise.resolve({ success: true, data });
const fail = (code: DriverErrorCode): DriverResult<never> => Promise.resolve(driverErr(code, "boom"));

describe("toE2eError", () => {
	const cases: [DriverErrorCode, E2eErrorCode][] = [
		["E_TIMEOUT", "TIMEOUT"],
		["E_APP_NOT_RESPONDING", "TIMEOUT"],
		["E_HELPER_MISSING", "DRIVER"],
		["E_NOT_BOOTED", "DRIVER"],
		["E_INTERNAL", "DRIVER"],
		["E_HID", "ACTION_FAILED"],
		["E_NO_ELEMENT", "ACTION_FAILED"],
		["E_UNSUPPORTED", "ACTION_FAILED"],
	];
	for (const [driverCode, code] of cases) {
		test(`${driverCode} -> ${code}`, () => {
			const error = toE2eError({ code: driverCode, message: "boom", retryable: false }, "tap");
			expect(error).toBeInstanceOf(E2eError);
			expect(error.code).toBe(code);
			expect(error.message).toContain("tap");
			expect(error.message).toContain(driverCode);
		});
	}
});

describe("unwrap", () => {
	test("returns data", async () => {
		expect(await unwrap(() => ok(3), "x")).toBe(3);
	});
	test("throws E2eError on failure", async () => {
		const error = await unwrap(() => fail("E_HID"), "tap").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(E2eError);
		expect((error as E2eError).code).toBe("ACTION_FAILED");
	});
	test("throws TIMEOUT up front when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const pending = (): DriverResult<number> => {
			called = true;
			return ok(1);
		};
		const error = await unwrap(pending, "tap", controller.signal).catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("TIMEOUT");
		expect(called).toBe(false);
	});
	test("rejects with TIMEOUT when the signal aborts mid-call", async () => {
		const controller = new AbortController();
		const never = (): DriverResult<number> => new Promise(() => undefined);
		const run = unwrap(never, "settle", controller.signal).catch((e: unknown) => e);
		controller.abort();
		expect(((await run) as E2eError).code).toBe("TIMEOUT");
	});
});

describe("settled", () => {
	test("returns the raw result without throwing", async () => {
		const result = await settled(() => fail("E_UNSUPPORTED"), "settle");
		expect(result.success).toBe(false);
	});
});
