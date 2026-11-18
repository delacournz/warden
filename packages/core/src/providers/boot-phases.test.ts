import { describe, expect, test } from "bun:test";
import { bootPhaseClock } from "./boot-phases";

/** A clock the test moves by hand. */
function manualClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
	let t = start;
	return { now: () => t, advance: (ms) => (t += ms) };
}

describe("bootPhaseClock", () => {
	test("times each `Waiting on` phase of bootstatus output, booting first", () => {
		const clock = manualClock();
		const phases = bootPhaseClock(clock.now);
		phases.line("Monitoring boot status for warden-iphone-17-1 (U1).");
		phases.line("Booting");
		clock.advance(2_900);
		phases.line("[2026-11-18 13:43:44 +0000] Status=1, isTerminal=NO, Elapsed=00:02.");
		phases.line("Waiting on BackBoard");
		clock.advance(650);
		phases.line("Waiting on Data Migration");
		phases.line("Reason:Running plugin com.apple.-0LaunchServicesMigrator (00LaunchServicesMigrator.migrator)");
		clock.advance(17_400);
		phases.line("Finished");
		expect(phases.summary()).toBe("20.9 s (booting 2.9 s, backboard 0.7 s, data migration 17.4 s)");
	});

	test("a phase repeated on every status tick is one phase", () => {
		const clock = manualClock();
		const phases = bootPhaseClock(clock.now);
		phases.line("Waiting on Data Migration");
		clock.advance(1_000);
		phases.line("  Waiting on Data Migration  ");
		clock.advance(1_000);
		expect(phases.summary()).toBe("2.0 s (data migration 2.0 s)");
	});

	test("no progress lines: the total alone", () => {
		const clock = manualClock();
		const phases = bootPhaseClock(clock.now);
		clock.advance(1_234);
		expect(phases.summary()).toBe("1.2 s (booting 1.2 s)");
	});

	test("a phase that took no time is left out", () => {
		const clock = manualClock();
		const phases = bootPhaseClock(clock.now);
		phases.line("Waiting on BackBoard");
		clock.advance(500);
		expect(phases.summary()).toBe("0.5 s (backboard 0.5 s)");
	});
});
