import { describe, expect, test } from "bun:test";
import { formatDegrees, formatScale, fraction, pathLength } from "./readout";

describe("formatScale", () => {
	test("two decimals", () => {
		expect(formatScale(1)).toBe("1.00");
		expect(formatScale(1.4567)).toBe("1.46");
	});
});

describe("formatDegrees", () => {
	test("radians to rounded degrees", () => {
		expect(formatDegrees(Math.PI / 4)).toBe("45");
		expect(formatDegrees(-Math.PI / 4)).toBe("-45");
	});

	test("zero never prints as -0", () => {
		expect(formatDegrees(0)).toBe("0");
		expect(formatDegrees(-0.0001)).toBe("0");
	});
});

describe("fraction", () => {
	test("value over size, two decimals", () => {
		expect(fraction(30, 100)).toBe("0.30");
		expect(fraction(-15, 100)).toBe("-0.15");
	});

	test("zero size gives 0.00", () => {
		expect(fraction(10, 0)).toBe("0.00");
	});

	test("negative zero prints as 0.00", () => {
		expect(fraction(-0.0001, 100)).toBe("0.00");
	});
});

describe("pathLength", () => {
	test("sums segment lengths", () => {
		expect(
			pathLength([
				{ x: 0, y: 0 },
				{ x: 3, y: 4 },
				{ x: 3, y: 10 },
			])
		).toBe(11);
	});

	test("fewer than two points is 0", () => {
		expect(pathLength([])).toBe(0);
		expect(pathLength([{ x: 1, y: 1 }])).toBe(0);
	});
});
