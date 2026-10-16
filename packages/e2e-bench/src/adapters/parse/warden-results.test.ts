import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeNameOf, parseWardenResults, stepsFromTrace } from "./warden-results";

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
