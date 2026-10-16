import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTrace, type TraceEvent } from "@delacour/warden-e2e/runner/trace";
import { nativeNameOf, parseWardenResults, stepsFromTrace, untracedMsOf } from "./warden-results";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "../fixtures/warden", name), "utf8");

describe("nativeNameOf", () => {
	test("basename of the file, then the joined title", () => {
		expect(nativeNameOf("/a/b/todo-detail.e2e.ts", ["x", "y"])).toBe("todo-detail.e2e.ts › x › y");
	});
});

describe("parseWardenResults", () => {
	const trace = fixture("trace-onboarding.jsonl");
	const read = (path: string) =>
		path.endsWith("onboarding-steps-through-to-sign-in-a1b2c3/trace.jsonl") ? trace : undefined;
	const tests = parseWardenResults(fixture("results.jsonl"), read, "/out");

	test("skips invalid lines and keeps file order", () => {
		expect(tests.map((t) => t.nativeName)).toEqual([
			"onboarding.e2e.ts › onboarding steps through to sign-in",
			"sign-in.e2e.ts › a locked account shows the form alert",
			"todos.e2e.ts › add, complete and filter todos",
		]);
	});

	test("carries status, duration and error", () => {
		expect(tests.map((t) => [t.status, t.durationMs])).toEqual([
			["passed", 9210],
			["failed", 14000],
			["timed-out", 120000],
		]);
		expect(tests[1]?.error).toBe("expected sign-in-form-error to be visible");
		expect(tests[0]?.error).toBeUndefined();
	});

	test("steps come from the trace's step-end events", () => {
		expect(tests[0]?.steps).toEqual([
			{ kind: "app", label: "open nz.co.delacour.warden.example", ms: 1000, status: "passed" },
			{ kind: "locator", label: "tap welcome-next", ms: 300, status: "passed" },
			{ kind: "expect", label: "toBeVisible sign-in-screen", ms: 5000, status: "failed" },
		]);
		expect(tests[1]?.steps).toEqual([]);
	});

	test("artifacts are typed and relative to the out dir", () => {
		expect(tests[1]?.artifacts).toEqual([
			{ kind: "screenshot", path: "sign-in/a-locked-account-d4e5f6/failure.png" },
			{ kind: "log", path: "sign-in/a-locked-account-d4e5f6/screen-at-failure.txt" },
			{ kind: "json", path: "sign-in/a-locked-account-d4e5f6/trace.jsonl" },
		]);
		expect(tests[2]?.artifacts).toEqual([]);
	});
});

describe("stepsFromTrace", () => {
	test("no events, no steps", () => {
		expect(stepsFromTrace([])).toEqual([]);
	});
});

const T = 1760600000000;
const WINDOW = { startedAt: T, durationMs: 10_000 };
const step = (end: number, ms: number): TraceEvent => ({
	type: "step-end",
	ts: T + end,
	kind: "locator",
	label: "tap",
	status: "passed",
	ms,
});
const span = (start: number, ms: number): TraceEvent => ({
	type: "span",
	ts: T + start,
	op: "driver.tap",
	ms,
	ok: true,
});

describe("untracedMsOf", () => {
	test("a test with no events is untraced from start to end", () => {
		expect(untracedMsOf([], WINDOW)).toBe(10_000);
	});

	test("a step covers [end - ms, end], a span covers [start, start + ms]", () => {
		expect(untracedMsOf([step(1000, 400)], WINDOW)).toBe(9600);
		expect(untracedMsOf([span(1000, 400)], WINDOW)).toBe(9600);
	});

	test("overlapping and nested intervals count once", () => {
		const events = [step(1000, 1000), span(100, 500), span(900, 300), span(1100, 100)];
		expect(untracedMsOf(events, WINDOW)).toBe(10_000 - 1200);
	});

	test("disjoint intervals add up", () => {
		expect(untracedMsOf([span(0, 100), span(500, 100), step(2000, 300)], WINDOW)).toBe(10_000 - 500);
	});

	test("what falls outside the test window does not count", () => {
		expect(untracedMsOf([span(-100, 200), span(9900, 500)], WINDOW)).toBe(10_000 - 100 - 100);
		expect(untracedMsOf([span(-500, 100), span(20_000, 100)], WINDOW)).toBe(10_000);
	});

	test("never negative and ignores notes, screenshots and unfinished steps", () => {
		const events: TraceEvent[] = [
			span(0, 50_000),
			{ type: "note", ts: T, kind: "note", label: "n" },
			{ type: "step-start", ts: T + 10, kind: "x", label: "y" },
		];
		expect(untracedMsOf(events, WINDOW)).toBe(0);
	});

	test("the fixture timeline: 1.9 s covered out of 10 s", () => {
		const events = readTrace(fixture("trace-spans.jsonl"));
		expect(untracedMsOf(events, WINDOW)).toBe(8100);
	});
});

describe("parseWardenResults untracedMs", () => {
	const line = (over: object) =>
		`${JSON.stringify({
			file: "/s/onboarding.e2e.ts",
			title: ["a"],
			status: "passed",
			durationMs: 10_000,
			startedAt: T,
			artifacts: { dir: "/out/a", files: ["trace.jsonl"] },
			device: { udid: "U1", platform: "ios" },
			...over,
		})}\n`;

	test("is measured from the attempt's trace, spans included, and steps still count only step-end events", () => {
		const trace = fixture("trace-spans.jsonl");
		const [test] = parseWardenResults(line({}), (path) => (path === "/out/a/trace.jsonl" ? trace : undefined), "/out");
		expect(test?.untracedMs).toBe(8100);
		expect(test?.steps.map((s) => s.label)).toEqual(["app.open", "tap welcome-next"]);
	});

	test("a test without a trace has no untracedMs", () => {
		const [test] = parseWardenResults(line({ artifacts: undefined }), () => undefined, "/out");
		expect(test).toBeDefined();
		expect(test).not.toHaveProperty("untracedMs");
	});

	test("an unreadable trace file has none either", () => {
		const [test] = parseWardenResults(line({}), () => undefined, "/out");
		expect(test).not.toHaveProperty("untracedMs");
	});
});
