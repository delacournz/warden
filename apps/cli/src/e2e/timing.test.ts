import { describe, expect, test } from "bun:test";
import { runTiming, timingLine } from "./timing";

describe("runTiming", () => {
	test("setup = start → first spec, tests = the specs' window, teardown = after them → now", () => {
		expect(runTiming(1_000, { testsStartedAt: 87_000, testsEndedAt: 173_000 }, 175_000)).toEqual({
			totalMs: 174_000,
			setupMs: 86_000,
			testsMs: 86_000,
			teardownMs: 2_000,
		});
	});

	test("a session that never ran a spec has no split", () => {
		expect(runTiming(1_000, {}, 5_000)).toBeUndefined();
		expect(runTiming(1_000, { testsStartedAt: 2_000 }, 5_000)).toBeUndefined();
	});

	test("a clock that steps back never gives a negative part", () => {
		const t = runTiming(10_000, { testsStartedAt: 9_000, testsEndedAt: 8_000 }, 7_000);
		expect(t).toEqual({ totalMs: 0, setupMs: 0, testsMs: 0, teardownMs: 0 });
	});
});

describe("timingLine", () => {
	test("`warden e2e: took <total> — setup <s> · tests <t> · teardown <d>`", () => {
		expect(timingLine({ totalMs: 172_000, setupMs: 84_000, testsMs: 86_000, teardownMs: 2_000 })).toBe(
			"warden e2e: took 2m52s — setup 1m24s · tests 1m26s · teardown 2s"
		);
	});
});
