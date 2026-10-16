import { describe, expect, test } from "bun:test";
import { bytes, ms, pct, ratio, signedMs, signedPct } from "./format";

describe("format", () => {
	test("ms", () => {
		expect(ms(850)).toBe("850 ms");
		expect(ms(1234)).toBe("1.23 s");
		expect(ms(0)).toBe("0 ms");
		expect(ms(Number.NaN)).toBe("—");
		expect(ms(undefined)).toBe("—");
	});
	test("signedMs", () => {
		expect(signedMs(1200)).toBe("+1.20 s");
		expect(signedMs(-150)).toBe("-150 ms");
		expect(signedMs(0)).toBe("0 ms");
		expect(signedMs(Number.NaN)).toBe("—");
	});
	test("pct", () => {
		expect(pct(1)).toBe("100%");
		expect(pct(0.975)).toBe("97.5%");
		expect(pct(Number.NaN)).toBe("—");
	});
	test("signedPct", () => {
		expect(signedPct(10)).toBe("+10.0%");
		expect(signedPct(-2.55)).toBe("-2.5%");
		expect(signedPct(undefined)).toBe("—");
	});
	test("bytes", () => {
		expect(bytes(512)).toBe("512 B");
		expect(bytes(12.3 * 1024 * 1024)).toBe("12.3 MB");
		expect(bytes(Number.NaN)).toBe("—");
	});
	test("ratio", () => {
		expect(ratio(1)).toBe("1.00×");
		expect(ratio(1.516)).toBe("1.52×");
		expect(ratio(undefined)).toBe("—");
	});
});
