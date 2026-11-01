import { describe, expect, test } from "bun:test";
import { durationParser } from "./duration";

describe("parseDuration", () => {
	test("units", () => {
		expect(durationParser.parse("500ms")).toEqual({ success: true, data: 500 });
		expect(durationParser.parse("30s")).toEqual({ success: true, data: 30_000 });
		expect(durationParser.parse("10m")).toEqual({ success: true, data: 600_000 });
		expect(durationParser.parse("2h")).toEqual({ success: true, data: 7_200_000 });
		expect(durationParser.parse("1.5m")).toEqual({ success: true, data: 90_000 });
	});

	test("bare number is seconds", () => {
		expect(durationParser.parse("45")).toEqual({ success: true, data: 45_000 });
	});

	test("invalid", () => {
		expect(durationParser.parse("soon").success).toBe(false);
		expect(durationParser.parse("-1m").success).toBe(false);
	});
});

describe("formatDuration", () => {
	test("compact", () => {
		expect(durationParser.format(4_000)).toBe("4s");
		expect(durationParser.format(125_000)).toBe("2m5s");
		expect(durationParser.format(3_720_000)).toBe("1h2m");
	});
});
