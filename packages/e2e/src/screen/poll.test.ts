import { describe, expect, test } from "bun:test";
import { poll, systemClock } from "./poll";
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
