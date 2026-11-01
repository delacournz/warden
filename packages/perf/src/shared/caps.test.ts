import { describe, expect, test } from "bun:test";
import { captureCaps, DEFAULT_MAX_DURATION_MS, HARD_MAX_DURATION_MS } from "./caps";

describe("clampMaxDuration", () => {
	test("defaults to 30s", () => {
		expect(captureCaps.clampMaxDuration(undefined)).toEqual({ ms: DEFAULT_MAX_DURATION_MS, clamped: false });
		expect(DEFAULT_MAX_DURATION_MS).toBe(30_000);
	});

	test("keeps a value within the hard max", () => {
		expect(captureCaps.clampMaxDuration(120_000)).toEqual({ ms: 120_000, clamped: false });
		expect(captureCaps.clampMaxDuration(HARD_MAX_DURATION_MS)).toEqual({ ms: 300_000, clamped: false });
	});

	test("clamps anything over 5m with a warning", () => {
		const r = captureCaps.clampMaxDuration(600_000);
		expect(r.ms).toBe(300_000);
		expect(r.clamped).toBe(true);
		expect(r.warning).toContain("5m");
	});

	test("a zero or negative request falls back to the default", () => {
		expect(captureCaps.clampMaxDuration(0).ms).toBe(DEFAULT_MAX_DURATION_MS);
		expect(captureCaps.clampMaxDuration(-5).ms).toBe(DEFAULT_MAX_DURATION_MS);
	});
});

describe("overCap", () => {
	test("is true once the session has run longer than its cap", () => {
		expect(captureCaps.overCap({ startedWallMs: 1_000, maxDurationMs: 30_000 }, 30_999)).toBe(false);
		expect(captureCaps.overCap({ startedWallMs: 1_000, maxDurationMs: 30_000 }, 31_000)).toBe(true);
	});
});
