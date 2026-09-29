import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "./duration";

describe("parseDuration", () => {
	test("units", () => {
		expect(parseDuration("500ms")).toEqual({ success: true, data: 500 });
		expect(parseDuration("30s")).toEqual({ success: true, data: 30_000 });
		expect(parseDuration("10m")).toEqual({ success: true, data: 600_000 });
		expect(parseDuration("2h")).toEqual({ success: true, data: 7_200_000 });
		expect(parseDuration("1.5m")).toEqual({ success: true, data: 90_000 });
	});

	test("bare number is seconds", () => {
		expect(parseDuration("45")).toEqual({ success: true, data: 45_000 });
	});

	test("invalid", () => {
		expect(parseDuration("soon").success).toBe(false);
		expect(parseDuration("-1m").success).toBe(false);
	});
});

describe("formatDuration", () => {
	test("compact", () => {
		expect(formatDuration(4_000)).toBe("4s");
		expect(formatDuration(125_000)).toBe("2m5s");
		expect(formatDuration(3_720_000)).toBe("1h2m");
	});
});
