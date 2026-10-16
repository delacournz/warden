import { describe, expect, test } from "bun:test";
import { noteSpanDetail } from "../driver/span-detail";
import { E2eError } from "../errors";
import { runSpan } from "./span";
import type { TraceEvent } from "./trace";

function sink() {
	const events: TraceEvent[] = [];
	return { events, write: (event: TraceEvent) => void events.push(event) };
}

/** A clock that advances `step` ms per reading. */
function ticking(start = 1000, step = 7): () => number {
	let t = start - step;
	return () => {
		t += step;
		return t;
	};
}

describe("runSpan", () => {
	test("writes one span with the start time, the duration and ok", async () => {
		const out = sink();
		const value = await runSpan(out, "driver.tap", async () => 42, { now: ticking(1000, 7) });
		expect(value).toBe(42);
		expect(out.events).toEqual([{ type: "span", ts: 1000, op: "driver.tap", ms: 7, ok: true }]);
	});

	test("without a trace it just runs the call", async () => {
		expect(await runSpan(undefined, "driver.tap", async () => "x")).toBe("x");
	});

	test("a throw is written as a failed span with the error code, then rethrown", async () => {
		const out = sink();
		const failure = new E2eError("TIMEOUT", "slow");
		await expect(
			runSpan(
				out,
				"device.settle",
				async () => {
					throw failure;
				},
				{ now: ticking() }
			)
		).rejects.toBe(failure);
		expect(out.events).toEqual([{ type: "span", ts: 1000, op: "device.settle", ms: 7, ok: false, code: "TIMEOUT" }]);
	});

	test("a throw without a code is written as ERROR", async () => {
		const out = sink();
		await expect(
			runSpan(out, "read.text", async () => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");
		expect(out.events[0]).toMatchObject({ type: "span", op: "read.text", ok: false, code: "ERROR" });
	});

	test("a verdict can fail a call that did not throw (a driver Result)", async () => {
		const out = sink();
		await runSpan(out, "driver.snapshot", async () => ({ success: false, code: "E_AX_UNAVAILABLE" }), {
			verdict: (value) => (value.success ? { ok: true } : { ok: false, code: value.code }),
		});
		expect(out.events[0]).toMatchObject({ ok: false, code: "E_AX_UNAVAILABLE" });
	});

	test("notes made inside the call become the span's detail", async () => {
		const out = sink();
		await runSpan(out, "driver.snapshot", async () => {
			noteSpanDetail("route", "tty");
			await Promise.resolve();
			noteSpanDetail("adbMs", 40);
		});
		expect(out.events[0]).toMatchObject({ detail: { route: "tty", adbMs: 40 } });
	});

	test("detail from the result is merged over the notes", async () => {
		const out = sink();
		await runSpan(
			out,
			"device.settle",
			async () => {
				noteSpanDetail("a", 1);
				return { via: "stream" };
			},
			{ detail: (value) => ({ via: value.via }) }
		);
		expect(out.events[0]).toMatchObject({ detail: { a: 1, via: "stream" } });
	});

	test("an empty detail is left out of the line", async () => {
		const out = sink();
		await runSpan(out, "x", async () => 1, { detail: () => undefined });
		expect(out.events[0]).not.toHaveProperty("detail");
	});

	test("a sink that throws never fails the call", async () => {
		const broken = {
			write(): void {
				throw new Error("disk full");
			},
		};
		expect(await runSpan(broken, "x", async () => "fine")).toBe("fine");
		await expect(
			runSpan(broken, "x", async () => {
				throw new Error("the call's own error");
			})
		).rejects.toThrow("the call's own error");
	});

	test("a call that is already running keeps writing to the trace it started under", async () => {
		const first = sink();
		const second = sink();
		let current = first;
		const done = runSpan(current, "driver.snapshot", async () => {
			await new Promise((resolve) => setTimeout(resolve, 2));
		});
		current = second;
		await done;
		expect(first.events).toHaveLength(1);
		expect(second.events).toHaveLength(0);
	});
});
