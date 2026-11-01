import { describe, expect, test } from "bun:test";
import { resultFactory } from "./result";

describe("result", () => {
	test("ok wraps data", () => {
		expect(resultFactory.ok(1)).toEqual({ success: true, data: 1 });
	});

	test("err extracts Error message", () => {
		expect(resultFactory.err(new Error("boom"))).toEqual({ success: false, error: "boom" });
	});

	test("err stringifies non-Error values", () => {
		expect(resultFactory.err(42)).toEqual({ success: false, error: "42" });
	});
});
