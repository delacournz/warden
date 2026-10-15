import { describe, expect, test } from "bun:test";
import type { RunEvent, RunEventOf } from "e2e";
import { createEventFormatter } from "./timestamps";

/** local 09:05:03.007 + `ms` */
const at = (ms = 0): string => new Date(new Date(2026, 9, 15, 9, 5, 3, 7).getTime() + ms).toISOString();

const KEY = { testId: "t1", agent: "default", repeat: 0, target: "ios" } as const;

const started = (ms = 0): RunEvent => ({
	seq: 1,
	at: at(ms),
	type: "test-started",
	...KEY,
	title: "signs in",
	file: "e2e/sign-in.e2e.ts",
	serialId: undefined,
});

type Progress = RunEventOf<"step">["progress"];
const step = (ms: number, progress: Progress): RunEvent => ({ seq: 2, at: at(ms), type: "step", ...KEY, progress });

const finished = (ms: number, status: "passed" | "failed" | "skipped", device?: string): RunEvent => ({
	seq: 3,
	at: at(ms),
	type: "test-finished",
	result: {
		test: {
			kind: "test",
			title: "signs in",
			titlePath: ["signs in"],
			declarationIndex: 0,
			sessions: [],
			tags: [],
			source: undefined,
			file: "e2e/sign-in.e2e.ts",
			id: "t1",
			serialId: undefined,
		},
		target: { name: "ios", platform: "ios" },
		agent: "default",
		repeat: 0,
		status,
		selected: true,
		attempts: [
			{
				id: "a1",
				index: 0,
				status,
				startedAt: at(0),
				durationMs: ms,
				steps: [],
				artifacts: [],
				secondaryErrors: [],
				cleanup: "complete",
				...(device ? { environment: { device } } : {}),
			},
		],
	},
});

describe("createEventFormatter", () => {
	test("test start + end: file, title, status, duration, device", () => {
		const format = createEventFormatter({ clock: false });
		expect(format(started())).toBe("▶ test |ios| e2e/sign-in.e2e.ts › signs in");
		expect(format(finished(18_520, "passed", "4AC630AF"))).toBe(
			"■ test |ios| e2e/sign-in.e2e.ts › signs in passed 18.52s on 4AC630AF"
		);
	});

	test("no device recorded → no `on`; a failure says failed", () => {
		const format = createEventFormatter({ clock: false });
		format(started());
		expect(format(finished(1_000, "failed"))).toBe("■ test |ios| e2e/sign-in.e2e.ts › signs in failed 1.00s");
	});

	test("steps: start + end, nested ones indented, failures carry the error", () => {
		const format = createEventFormatter({ clock: false });
		format(started());
		const outer = { kind: "screen", api: "screen.tap", label: 'tap "Sign in"' } as const;
		const inner = { kind: "locator", api: "locator.wait", label: "wait for todos" } as const;
		expect(format(step(10, { phase: "start", ...outer }))).toBe('  ▸ sign-in › screen tap "Sign in"');
		expect(format(step(20, { phase: "start", ...inner }))).toBe("    ▸ sign-in › locator wait for todos");
		expect(
			format(
				step(520, {
					phase: "end",
					...inner,
					status: "failed",
					durationMs: 500,
					modelCalls: 0,
					error: { category: "test", code: "TIMEOUT", message: "not found", retryable: false },
				})
			)
		).toBe("    ▪ sign-in › locator wait for todos failed 500ms — not found");
		expect(format(step(530, { phase: "end", ...outer, status: "passed", durationMs: 520, modelCalls: 0 }))).toBe(
			'  ▪ sign-in › screen tap "Sign in" passed 520ms'
		);
	});

	test("a test that never started (not selected / skipped up front) prints no end line", () => {
		const format = createEventFormatter({ clock: false });
		expect(format(finished(0, "skipped"))).toBeUndefined();
	});

	test("a step without a label shows its api", () => {
		const format = createEventFormatter({ clock: false });
		format(started());
		expect(format(step(0, { phase: "start", kind: "app", api: "app.open", label: "" }))).toBe(
			"  ▸ sign-in › app app.open"
		);
	});

	test("step activity / events and unknown event types print nothing", () => {
		const format = createEventFormatter({ clock: false });
		expect(format(step(0, { phase: "activity", api: "screen.tap", activity: "action" }))).toBeUndefined();
		expect(format({ seq: 9, at: at(), type: "run-stopped", failures: 1, limit: 1 })).toBeUndefined();
	});

	test("run + setup lines", () => {
		const format = createEventFormatter({ clock: false });
		expect(
			format({
				seq: 1,
				at: at(),
				type: "setup",
				step: { kind: "prepare", target: "ios", engine: "mobile" },
				state: "started",
			})
		).toBe("⏵ setup prepare ios");
		expect(
			format({
				seq: 2,
				at: at(),
				type: "setup",
				step: { kind: "prepare", target: "ios", engine: "mobile" },
				state: "finished",
				durationMs: 30_230,
				outcome: "reused",
			})
		).toBe("⏹ setup prepare ios 30.23s (reused)");
		expect(format({ seq: 3, at: at(), type: "run-finished", status: "passed", exitCode: 0 })).toBe(
			"⏹ run finished passed (exit 0)"
		);
	});

	test("clock: true prefixes the event's local time", () => {
		const format = createEventFormatter({ clock: true });
		expect(format(started(1))).toBe("[09:05:03.008] ▶ test |ios| e2e/sign-in.e2e.ts › signs in");
	});
});
