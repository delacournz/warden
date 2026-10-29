import { describe, expect, test } from "bun:test";
import type { LocationCondition, NetworkCondition } from "@delacour/warden-core/conditions/conditions.types";
import { type ConditionEvent, eventKind } from "./condition-events";
import { type SchedulerTarget, type StepResult, seededRng, startFlap, startTimeline } from "./scheduler";

/** Virtual time: a sleep moves the clock forward at once (after a macrotask turn), or ends early on abort. */
function fakeClock() {
	let t = 1_000;
	return {
		now: () => t,
		sleep: (ms: number, signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				if (signal.aborted) return resolve();
				setTimeout(() => {
					t += ms;
					resolve();
				}, 0);
				signal.addEventListener("abort", () => resolve());
			}),
	};
}

const okStep: StepResult = { success: true };

function recorder(failWhen: (n: number, kind: string) => boolean = () => false) {
	const calls: { at: number; area: "network" | "location"; value: NetworkCondition | LocationCondition }[] = [];
	let n = 0;
	const clock = fakeClock();
	const target: SchedulerTarget = {
		network: async (value) => {
			n++;
			if (failWhen(n, value.kind)) return { success: false, error: { message: `boom ${n}` } };
			calls.push({ at: clock.now(), area: "network", value });
			return okStep;
		},
		location: async (value) => {
			n++;
			if (failWhen(n, value.kind)) return { success: false, error: { message: `boom ${n}` } };
			calls.push({ at: clock.now(), area: "location", value });
			return okStep;
		},
	};
	return { target, calls, clock };
}

const kinds = (calls: { value: { kind: string } }[]): string[] => calls.map((c) => c.value.kind);

describe("seededRng", () => {
	test("same seed, same sequence; different seed differs; stays in [0, 1)", () => {
		const a = seededRng(7);
		const b = seededRng(7);
		const seq = Array.from({ length: 5 }, () => a());
		expect(seq).toEqual(Array.from({ length: 5 }, () => b()));
		expect(seq.every((x) => x >= 0 && x < 1)).toBe(true);
		expect(seededRng(8)()).not.toBe(seq[0]);
	});
});

describe("startFlap", () => {
	test("alternates base and offline on the up/down schedule, and stop restores base", async () => {
		const { target, calls, clock } = recorder();
		const events: ConditionEvent[] = [];
		const flap = startFlap(target, { upMs: 100, downMs: 40 }, { ...clock, sink: (e) => events.push(e) });
		while (calls.length < 4) await Bun.sleep(1);
		flap.stop();
		const outcome = await flap.done;
		expect(outcome.stopped).toBe("aborted");
		expect(kinds(calls).slice(0, 4)).toEqual(["online", "offline", "online", "offline"]);
		expect(calls.slice(0, 4).map((c) => c.at)).toEqual([1000, 1100, 1140, 1240]);
		expect(kinds(calls).at(-1)).toBe("online");
		expect(events.map((e) => e.area)).toEqual(calls.map(() => "network"));
		expect(events.map((e) => e.at)).toEqual(calls.map((c) => c.at));
		expect(flap.current()).toEqual({ state: "stopped", transitions: calls.length });
	});

	test("stopped during the up phase leaves nothing to restore", async () => {
		const { target, calls, clock } = recorder();
		const flap = startFlap(target, { upMs: 50, downMs: 50 }, clock);
		while (calls.length < 1) await Bun.sleep(1);
		flap.stop();
		await flap.done;
		expect(kinds(calls)).toEqual(["online"]);
	});

	test("custom base is the up phase and what stop restores", async () => {
		const { target, calls, clock } = recorder();
		const base: NetworkCondition = { kind: "preset", preset: "3g" };
		const flap = startFlap(target, { upMs: 10, downMs: 10, base }, clock);
		while (calls.length < 2) await Bun.sleep(1);
		flap.stop();
		await flap.done;
		expect(calls[0]?.value).toEqual(base);
		expect(calls[1]?.value).toEqual({ kind: "offline" });
		expect(calls.at(-1)?.value).toEqual(base);
	});

	test("jitter is deterministic for a seed and bounded by jitterPct", async () => {
		const run = async (seed: number) => {
			const { target, calls, clock } = recorder();
			const flap = startFlap(target, { upMs: 1000, downMs: 1000, jitterPct: 20, seed }, clock);
			while (calls.length < 6) await Bun.sleep(1);
			flap.stop();
			await flap.done;
			return calls.slice(0, 6).map((c) => c.at);
		};
		const a = await run(42);
		expect(await run(42)).toEqual(a);
		expect(await run(43)).not.toEqual(a);
		for (let i = 1; i < a.length; i++) {
			const gap = (a[i] as number) - (a[i - 1] as number);
			expect(gap).toBeGreaterThanOrEqual(800);
			expect(gap).toBeLessThanOrEqual(1200);
		}
		expect(new Set(a.slice(1).map((x, i) => x - (a[i] as number))).size).toBeGreaterThan(1);
	});

	test("an injected rng wins over the seed", async () => {
		const { target, calls, clock } = recorder();
		const flap = startFlap(target, { upMs: 100, downMs: 100, jitterPct: 50 }, { ...clock, rng: () => 1 });
		while (calls.length < 3) await Bun.sleep(1);
		flap.stop();
		await flap.done;
		expect(calls.slice(0, 3).map((c) => c.at)).toEqual([1000, 1150, 1300]);
	});

	test("applyInitial false waits out the first up phase without touching the device", async () => {
		const { target, calls, clock } = recorder();
		const flap = startFlap(target, { upMs: 100, downMs: 100, applyInitial: false }, clock);
		while (calls.length < 1) await Bun.sleep(1);
		flap.stop();
		await flap.done;
		expect(kinds(calls).slice(0, 1)).toEqual(["offline"]);
		expect(calls[0]?.at).toBe(1100);
	});

	test("3 failed transitions in a row end it as failed; a success resets the count", async () => {
		const failing = recorder((n) => n >= 3);
		const flap = startFlap(failing.target, { upMs: 10, downMs: 10 }, failing.clock);
		const outcome = await flap.done;
		expect(outcome).toEqual({ transitions: 2, stopped: "failed", error: "boom 5" });
		expect(flap.current()).toEqual({ state: "failed", transitions: 2, error: "boom 5" });

		const flaky = recorder((n) => n === 2 || n === 3 || n === 5 || n === 6);
		const survivor = startFlap(flaky.target, { upMs: 10, downMs: 10 }, flaky.clock);
		while (flaky.calls.length < 3) await Bun.sleep(1);
		survivor.stop();
		expect((await survivor.done).stopped).toBe("aborted");
	});

	test("a target that throws counts as a failure", async () => {
		const clock = fakeClock();
		const flap = startFlap(
			{
				network: async () => {
					throw new Error("adb gone");
				},
			},
			{ upMs: 10, downMs: 10 },
			clock
		);
		expect(await flap.done).toEqual({ transitions: 0, stopped: "failed", error: "adb gone" });
	});

	test("bad options fail at once without touching the device", async () => {
		const { target, calls, clock } = recorder();
		expect((await startFlap(target, { upMs: 0, downMs: 10 }, clock).done).stopped).toBe("failed");
		const nested = startFlap(target, { upMs: 1, downMs: 1, base: { kind: "flap", upMs: 1, downMs: 1 } }, clock);
		expect((await nested.done).stopped).toBe("failed");
		expect(calls).toEqual([]);
	});

	test("stop is idempotent", async () => {
		const { target, clock } = recorder();
		const flap = startFlap(target, { upMs: 10, downMs: 10 }, clock);
		flap.stop();
		flap.stop();
		expect((await flap.done).stopped).toBe("aborted");
	});
});

describe("startTimeline", () => {
	test("runs steps in atMs order relative to the start, network before location in one step", async () => {
		const { target, calls, clock } = recorder();
		const events: ConditionEvent[] = [];
		const point: LocationCondition = { kind: "point", lat: 1, lon: 2 };
		const tl = startTimeline(
			target,
			[
				{ atMs: 500, network: { kind: "online" } },
				{ atMs: 0, network: { kind: "offline" }, location: point },
				{ atMs: 200, location: { kind: "clear" } },
			],
			{ ...clock, sink: (e) => events.push(e) }
		);
		expect(await tl.done).toEqual({ transitions: 4, stopped: "finished" });
		expect(calls.map((c) => [c.at, c.area, c.value.kind])).toEqual([
			[1000, "network", "offline"],
			[1000, "location", "point"],
			[1200, "location", "clear"],
			[1500, "network", "online"],
		]);
		expect(events.map((e) => `${e.area}:${eventKind(e)}`)).toEqual([
			"network:offline",
			"location:point",
			"location:clear",
			"network:online",
		]);
		expect(tl.current()).toEqual({ state: "finished", transitions: 4 });
	});

	test("equal atMs keep the given order", async () => {
		const { target, calls, clock } = recorder();
		const tl = startTimeline(
			target,
			[
				{ atMs: 10, network: { kind: "offline" } },
				{ atMs: 10, network: { kind: "online" } },
			],
			clock
		);
		await tl.done;
		expect(kinds(calls)).toEqual(["offline", "online"]);
	});

	test("stop cancels the remaining steps", async () => {
		const { target, calls, clock } = recorder();
		const tl = startTimeline(
			target,
			[
				{ atMs: 0, network: { kind: "offline" } },
				{ atMs: 60_000, network: { kind: "online" } },
			],
			{
				...clock,
				sleep: (ms, signal) =>
					ms > 1000 ? new Promise<void>((r) => signal.addEventListener("abort", () => r())) : clock.sleep(ms, signal),
			}
		);
		while (calls.length < 1) await Bun.sleep(1);
		tl.stop();
		expect(await tl.done).toEqual({ transitions: 1, stopped: "aborted" });
		expect(kinds(calls)).toEqual(["offline"]);
	});

	test("3 failed steps in a row end it as failed; one failing part fails its step but the other part still runs", async () => {
		const failing = recorder((_n, kind) => kind === "offline");
		const tl = startTimeline(
			failing.target,
			[
				{ atMs: 0, network: { kind: "offline" }, location: { kind: "clear" } },
				{ atMs: 1, network: { kind: "offline" } },
				{ atMs: 2, network: { kind: "offline" } },
				{ atMs: 3, network: { kind: "online" } },
			],
			failing.clock
		);
		const outcome = await tl.done;
		expect(outcome.stopped).toBe("failed");
		expect(outcome.transitions).toBe(1);
		expect(failing.calls.map((c) => c.value.kind)).toEqual(["clear"]);
	});

	test("a target without the area fails the step", async () => {
		const clock = fakeClock();
		const tl = startTimeline({}, [{ atMs: 0, network: { kind: "offline" } }], clock);
		expect((await tl.done).transitions).toBe(0);
	});

	test("negative atMs is rejected up front", async () => {
		const { target, calls, clock } = recorder();
		const outcome = await startTimeline(target, [{ atMs: -1, network: { kind: "offline" } }], clock).done;
		expect(outcome.stopped).toBe("failed");
		expect(calls).toEqual([]);
	});
});
