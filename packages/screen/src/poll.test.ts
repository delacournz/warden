import { describe, expect, test } from "bun:test";
import { DEFAULT_POLL_SCHEDULE, poll, systemClock } from "./poll";
import { fakeClock } from "./poll.testing";

describe("poll", () => {
	test("returns the value as soon as the step is done, without sleeping", async () => {
		const clock = fakeClock();
		const result = await poll(async () => ({ done: true, value: 7 }), { timeoutMs: 1000, ...clock });
		expect(result).toEqual({ status: "done", value: 7, attempts: 1 });
		expect(clock.sleeps).toEqual([]);
	});

	test("retries every 100 ms by default", async () => {
		const clock = fakeClock();
		const result = await poll(
			async (attempt) => (attempt === 3 ? { done: true, value: "ok" } : { done: false, state: attempt }),
			{
				timeoutMs: 1000,
				...clock,
			}
		);
		expect(result).toEqual({ status: "done", value: "ok", attempts: 3 });
		expect(clock.sleeps).toEqual([100, 100]);
	});

	test("backs off after the first second: 100 ms apart for 1 s, then 250 ms", async () => {
		const clock = fakeClock();
		const result = await poll(async (attempt) => ({ done: false, state: attempt }), { timeoutMs: 3000, ...clock });
		expect(result).toEqual({ status: "timeout", last: 19, attempts: 19 });
		expect(clock.sleeps).toEqual([...Array.from({ length: 10 }, () => 100), ...Array.from({ length: 8 }, () => 250)]);
		expect(clock.elapsed()).toBe(3000);
	});

	test("the default schedule is what the plan says", () => {
		expect(DEFAULT_POLL_SCHEDULE).toEqual({ fastMs: 100, fastForMs: 1000, slowMs: 250 });
	});

	test("a 10 s wait makes about half the attempts a fixed 100 ms poll would", async () => {
		const clock = fakeClock();
		const result = await poll(async () => ({ done: false, state: undefined }), { timeoutMs: 10_000, ...clock });
		expect(result.attempts).toBe(1 + 10 + 36);
		const fixed = await poll(async () => ({ done: false, state: undefined }), {
			timeoutMs: 10_000,
			intervalMs: 100,
			...fakeClock(),
		});
		expect(fixed.attempts).toBe(101);
	});

	test("the last attempt lands on the deadline, never past it, whatever the phase", async () => {
		for (const timeoutMs of [50, 950, 1000, 1100, 1200, 1250, 1300, 2999, 3001]) {
			const clock = fakeClock();
			const seen: number[] = [];
			const result = await poll(
				async () => {
					seen.push(clock.elapsed());
					return { done: false, state: undefined };
				},
				{ timeoutMs, ...clock }
			);
			expect(result.status).toBe("timeout");
			expect(seen.at(-1)).toBe(timeoutMs);
			expect(clock.elapsed()).toBe(timeoutMs);
		}
	});

	test("the phase follows the clock, not the attempt count: slow steps reach the slow gap sooner", async () => {
		const clock = fakeClock();
		await poll(
			async () => {
				clock.advance(400);
				return { done: false, state: undefined };
			},
			{ timeoutMs: 3000, ...clock }
		);
		expect(clock.sleeps.slice(0, 4)).toEqual([100, 100, 250, 250]);
	});

	test("an explicit intervalMs is a fixed gap with no back-off", async () => {
		const clock = fakeClock();
		await poll(async () => ({ done: false, state: undefined }), { timeoutMs: 2500, intervalMs: 100, ...clock });
		expect(new Set(clock.sleeps)).toEqual(new Set([100]));
		expect(clock.sleeps.length).toBe(25);
	});

	test("a schedule option replaces the default one", async () => {
		const clock = fakeClock();
		await poll(async () => ({ done: false, state: undefined }), {
			timeoutMs: 1000,
			schedule: { fastMs: 50, fastForMs: 200, slowMs: 400 },
			...clock,
		});
		expect(clock.sleeps).toEqual([50, 50, 50, 50, 400, 400]);
	});

	test("a step can ask to be polled again sooner than the schedule says", async () => {
		const clock = fakeClock();
		await poll(async (attempt) => ({ done: false, state: undefined, ...(attempt === 12 ? { maxWaitMs: 40 } : {}) }), {
			timeoutMs: 1600,
			...clock,
		});
		expect(clock.sleeps.slice(9, 13)).toEqual([100, 250, 40, 250]);
	});

	test("an overdue hint polls again at once", async () => {
		const clock = fakeClock();
		await poll(async (attempt) => ({ done: false, state: undefined, ...(attempt === 1 ? { maxWaitMs: -5 } : {}) }), {
			timeoutMs: 300,
			...clock,
		});
		expect(clock.sleeps).toEqual([0, 100, 100, 100]);
	});

	test("times out with the last state and never overshoots the deadline", async () => {
		const clock = fakeClock();
		const result = await poll(async (attempt) => ({ done: false, state: `try ${attempt}` }), {
			timeoutMs: 250,
			intervalMs: 100,
			...clock,
		});
		expect(result).toEqual({ status: "timeout", last: "try 4", attempts: 4 });
		expect(clock.sleeps).toEqual([100, 100, 50]);
		expect(clock.elapsed()).toBe(250);
	});

	test("a zero timeout still tries once", async () => {
		const clock = fakeClock();
		const result = await poll(async () => ({ done: false, state: "x" }), { timeoutMs: 0, ...clock });
		expect(result).toEqual({ status: "timeout", last: "x", attempts: 1 });
		expect(clock.sleeps).toEqual([]);
	});

	test("an aborted signal stops the loop", async () => {
		const clock = fakeClock();
		const controller = new AbortController();
		const result = await poll(
			async (attempt) => {
				if (attempt === 2) controller.abort();
				return { done: false, state: attempt };
			},
			{ timeoutMs: 10_000, signal: controller.signal, ...clock }
		);
		expect(result).toEqual({ status: "aborted", attempts: 2 });
	});

	test("an already aborted signal never runs the step", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const result = await poll(
			async () => {
				calls += 1;
				return { done: true, value: 1 };
			},
			{ timeoutMs: 100, signal: controller.signal, ...fakeClock() }
		);
		expect(result.status).toBe("aborted");
		expect(calls).toBe(0);
	});

	test("errors from the step propagate", async () => {
		await expect(
			poll(
				async () => {
					throw new Error("boom");
				},
				{ timeoutMs: 100, ...fakeClock() }
			)
		).rejects.toThrow("boom");
	});
});

describe("systemClock", () => {
	test("sleep resolves after roughly the delay and early on abort", async () => {
		const started = systemClock.now();
		await systemClock.sleep(20);
		expect(systemClock.now() - started).toBeGreaterThanOrEqual(15);
		const controller = new AbortController();
		const pending = systemClock.sleep(10_000, controller.signal);
		controller.abort();
		await pending;
	});
});
