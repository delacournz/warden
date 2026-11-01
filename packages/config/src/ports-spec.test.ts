import { describe, expect, test } from "bun:test";
import { DEFAULT_PORT_SPAN, parsePortSpec } from "./ports-spec";

describe("parsePortSpec", () => {
	test("from:span", () => {
		expect(parsePortSpec("8091:20")).toEqual({ success: true, data: { from: 8091, span: 20 } });
		expect(parsePortSpec(" 3208:5 ")).toEqual({ success: true, data: { from: 3208, span: 5 } });
	});

	test("bare port uses the default span", () => {
		expect(DEFAULT_PORT_SPAN).toBe(20);
		expect(parsePortSpec("8091")).toEqual({ success: true, data: { from: 8091, span: 20 } });
	});

	test("rejects invalid specs", () => {
		for (const bad of ["", "abc", "0", "65536", "8091:0", "8091:-1", "8091:x", "65530:10", "1.5", "80:2:3"]) {
			expect(parsePortSpec(bad).success).toBe(false);
		}
	});

	test("range may end exactly at 65535", () => {
		expect(parsePortSpec("65535:1")).toEqual({ success: true, data: { from: 65535, span: 1 } });
	});
});
