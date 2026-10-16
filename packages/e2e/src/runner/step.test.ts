import { describe, expect, test } from "bun:test";
import type { AttemptContext } from "./fixtures.types";
import { runStep } from "./step";
import type { TraceEvent } from "./trace";

function attempt(controller = new AbortController()) {
	const events: TraceEvent[] = [];
	const ctx: AttemptContext = {
		signal: controller.signal,
		dir: "/d",
		short: "s",
		trace: { path: "/d/trace.jsonl", write: (e) => events.push(e), flush: () => undefined },
		depth: 0,
		files: new Set(),
		softFailures: [],
	};
	return { ctx, events, controller };
}

let t = 0;
const clock = (): number => {
	t += 10;
	return t;
};

describe("runStep", () => {
	test("without an attempt it just runs", async () => {
		expect(await runStep(undefined, "k", "l", async () => 5)).toBe(5);
	});

	test("writes start and end, with nesting depth restored", async () => {
		const { ctx, events } = attempt();
		const depths: number[] = [];
		const value = await runStep(
			ctx,
			"locator",
			"tap",
			async () => {
				depths.push(ctx.depth);
				return runStep(ctx, "driver", "snapshot", async () => 7, clock);
			},
			clock
		);
		expect(value).toBe(7);
		expect(depths).toEqual([1]);
		expect(ctx.depth).toBe(0);
		expect(events.flatMap((e) => (e.type === "span" ? [] : [[e.type, e.label]]))).toEqual([
			["step-start", "tap"],
			["step-start", "snapshot"],
			["step-end", "snapshot"],
			["step-end", "tap"],
		]);
		expect(events[2]).toMatchObject({ status: "passed", ms: expect.any(Number) });
	});

	test("a throwing step records the error and rethrows", async () => {
		const { ctx, events } = attempt();
		await expect(
			runStep(
				ctx,
				"expect",
				"visible",
				async () => {
					throw new Error("nope");
				},
				clock
			)
		).rejects.toThrow("nope");
		expect(events[1]).toMatchObject({ type: "step-end", status: "failed", error: "nope" });
		expect(ctx.depth).toBe(0);
	});

	test("gives up as soon as the signal aborts, even if the call never answers", async () => {
		const { ctx, events, controller } = attempt();
		const pending = runStep(ctx, "driver", "tap", () => new Promise<void>(() => undefined), clock);
		controller.abort(new Error("deadline"));
		await expect(pending).rejects.toThrow("deadline");
		expect(events.at(-1)).toMatchObject({ type: "step-end", status: "failed", error: "deadline" });
	});

	test("an already aborted attempt does not start the step", async () => {
		const { ctx, events, controller } = attempt();
		controller.abort(new Error("late"));
		let ran = false;
		await expect(
			runStep(ctx, "k", "l", async () => {
				ran = true;
			})
		).rejects.toThrow("late");
		expect(ran).toBe(false);
		expect(events).toEqual([]);
	});
});
