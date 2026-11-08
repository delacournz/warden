import { describe, expect, test } from "bun:test";
import { isTrialExpired, TRIAL_DAYS } from "./trial";

const DAY_MS = 86_400_000;

describe("isTrialExpired", () => {
	const installedAt = Date.parse("2026-01-01T00:00:00Z");

	test("active on the first day and on day 14", () => {
		expect(isTrialExpired(installedAt, installedAt)).toBe(false);
		expect(isTrialExpired(installedAt + TRIAL_DAYS * DAY_MS, installedAt)).toBe(false);
	});

	test("expired once more than 14 days have passed", () => {
		expect(isTrialExpired(installedAt + TRIAL_DAYS * DAY_MS + 1, installedAt)).toBe(true);
		expect(isTrialExpired(installedAt + 15 * DAY_MS, installedAt)).toBe(true);
	});
});
