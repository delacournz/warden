import { describe, expect, test } from "bun:test";
import { err, ok } from "./result";

describe("result", () => {
	test("ok wraps data", () => {
		expect(ok(1)).toEqual({ success: true, data: 1 });
	});

	test("err extracts Error message", () => {
		expect(err(new Error("boom"))).toEqual({ success: false, error: "boom" });
	});

	test("err stringifies non-Error values", () => {
		expect(err(42)).toEqual({ success: false, error: "42" });
	});
});
