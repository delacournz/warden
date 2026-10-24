import { describe, expect, test } from "bun:test";
import { bytes, coldStartCost, cpuSeconds, ms, pct, ratio, signedCpuSeconds, signedMs, signedPct } from "./format";

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
	test("coldStartCost flags a negative cost as not a duration", () => {
		expect(coldStartCost(-1974)).toBe("none (rep 1 not slower, -1.97 s)");
		expect(coldStartCost(60_766)).toBe(ms(60_766));
		expect(coldStartCost(undefined)).toBe("—");
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

describe("format CPU seconds", () => {
	test("cpuSeconds always in seconds with two decimals; signed for deltas", () => {
		expect(cpuSeconds(0.854)).toBe("0.85 s");
		expect(cpuSeconds(12.3)).toBe("12.30 s");
		expect(cpuSeconds(undefined)).toBe("—");
		expect(signedCpuSeconds(-1)).toBe("-1.00 s");
		expect(signedCpuSeconds(0.5)).toBe("+0.50 s");
		expect(signedCpuSeconds(Number.NaN)).toBe("—");
	});
});
