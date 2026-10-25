import { describe, expect, test } from "bun:test";
import { clampMaxDuration, DEFAULT_MAX_DURATION_MS, HARD_MAX_DURATION_MS, overCap } from "./caps";

describe("clampMaxDuration", () => {
	test("defaults to 30s", () => {
		expect(clampMaxDuration(undefined)).toEqual({ ms: DEFAULT_MAX_DURATION_MS, clamped: false });
		expect(DEFAULT_MAX_DURATION_MS).toBe(30_000);
	});

	test("keeps a value within the hard max", () => {
		expect(clampMaxDuration(120_000)).toEqual({ ms: 120_000, clamped: false });
		expect(clampMaxDuration(HARD_MAX_DURATION_MS)).toEqual({ ms: 300_000, clamped: false });
	});

	test("clamps anything over 5m with a warning", () => {
		const r = clampMaxDuration(600_000);
		expect(r.ms).toBe(300_000);
		expect(r.clamped).toBe(true);
		expect(r.warning).toContain("5m");
	});

	test("a zero or negative request falls back to the default", () => {
		expect(clampMaxDuration(0).ms).toBe(DEFAULT_MAX_DURATION_MS);
		expect(clampMaxDuration(-5).ms).toBe(DEFAULT_MAX_DURATION_MS);
	});
});

describe("overCap", () => {
	test("is true once the session has run longer than its cap", () => {
		expect(overCap({ startedWallMs: 1_000, maxDurationMs: 30_000 }, 30_999)).toBe(false);
		expect(overCap({ startedWallMs: 1_000, maxDurationMs: 30_000 }, 31_000)).toBe(true);
	});
});
