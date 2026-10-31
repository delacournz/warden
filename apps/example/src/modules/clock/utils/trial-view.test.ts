import { describe, expect, test } from "bun:test";
import { formatDay, formatOffset, trialCopy, trialLevel, trialStateOf } from "./trial-view";

const DAY = 86_400_000;
const START = Date.parse("2026-10-30T09:41:00Z");

describe("trialStateOf", () => {
	test("14 days left on day one, even a little later", () => {
		expect(trialStateOf(START, START)).toEqual({ kind: "active", daysLeft: 14 });
		expect(trialStateOf(START + 30_000, START)).toEqual({ kind: "active", daysLeft: 14 });
	});

	test("a clock moved back never shows more than 14 days", () => {
		expect(trialStateOf(START - 3 * DAY, START)).toEqual({ kind: "active", daysLeft: 14 });
	});

	test("10 days on, real seconds later, still 4 left", () => {
		expect(trialStateOf(START + 10 * DAY + 45_000, START)).toEqual({ kind: "active", daysLeft: 4 });
	});

	test("never reads 0 while the trial is active", () => {
		expect(trialStateOf(START + 14 * DAY, START)).toEqual({ kind: "active", daysLeft: 1 });
	});

	test("expires after day 14 and counts days since the end", () => {
		expect(trialStateOf(START + 14 * DAY + 1, START)).toEqual({ kind: "expired", daysAgo: 0 });
		expect(trialStateOf(START + 15 * DAY, START)).toEqual({ kind: "expired", daysAgo: 1 });
		expect(trialStateOf(START + 16 * DAY + 5000, START)).toEqual({ kind: "expired", daysAgo: 2 });
	});
});

describe("trialLevel", () => {
	test("is the elapsed day count while active and 15 once expired", () => {
		expect(trialLevel({ kind: "active", daysLeft: 14 })).toBe(0);
		expect(trialLevel({ kind: "active", daysLeft: 4 })).toBe(10);
		expect(trialLevel({ kind: "expired", daysAgo: 0 })).toBe(15);
	});
});

describe("formatDay", () => {
	test("is day and short month, from the UTC date", () => {
		expect(formatDay(START)).toBe("30 Oct");
		expect(formatDay(START + 14 * DAY)).toBe("13 Nov");
		expect(formatDay(Date.parse("2026-01-05T00:00:00Z"))).toBe("5 Jan");
	});
});

describe("trialCopy", () => {
	test("active", () => {
		expect(trialCopy({ kind: "active", daysLeft: 14 }, START)).toEqual({
			title: "14 days left",
			body: "Trial started 30 Oct, ends 13 Nov.",
		});
	});

	test("singular", () => {
		expect(trialCopy({ kind: "active", daysLeft: 1 }, START).title).toBe("1 day left");
	});

	test("expired", () => {
		expect(trialCopy({ kind: "expired", daysAgo: 2 }, START)).toEqual({
			title: "Trial expired",
			body: "Ended 13 Nov, 2 days ago.",
		});
		expect(trialCopy({ kind: "expired", daysAgo: 1 }, START).body).toBe("Ended 13 Nov, 1 day ago.");
		expect(trialCopy({ kind: "expired", daysAgo: 0 }, START).body).toBe("Ended 13 Nov, today.");
	});
});

describe("formatOffset", () => {
	test("under a second is 0s", () => {
		expect(formatOffset(0)).toBe("0s");
		expect(formatOffset(-400)).toBe("0s");
	});

	test("days and hours, signed, rounded to the minute", () => {
		expect(formatOffset(10 * DAY)).toBe("+10d 0h");
		expect(formatOffset(10 * DAY + 41)).toBe("+10d 0h");
		expect(formatOffset(-(15 * DAY) + 700)).toBe("−15d 0h");
		expect(formatOffset(2 * DAY + 5 * 3_600_000)).toBe("+2d 5h");
	});

	test("smaller units", () => {
		expect(formatOffset(5 * 3_600_000 + 30 * 60_000)).toBe("+5h 30m");
		expect(formatOffset(12 * 60_000)).toBe("+12m");
		expect(formatOffset(30_000)).toBe("+30s");
	});
});
