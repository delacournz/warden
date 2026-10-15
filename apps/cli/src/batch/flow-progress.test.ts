import { describe, expect, test } from "bun:test";
import { flowMarks } from "./flow-progress";

const flows = ["onboarding", "settings", "sign-in", "todo-detail", "todos"].map((id) => ({
	id,
	path: `e2e/${id}.e2e.ts`,
}));

/** A real `e2e run` (tester.army list reporter) log, interrupted mid-run. */
const RUN = `
 RUN  e2e v0.19.0 /Users/me/apps/example
      run 01a139be · targets: ios

ℹ booting 4AC630AF (1 of 2)
 ✓ mobile engine for target "ios" prepared 31.36s
 ✓ |ios| e2e/onboarding.e2e.ts (1 test) 6.79s
 ✓ |ios| e2e/settings.e2e.ts (1 test) 25.71s
interrupted: stopping the running test and tearing down (interrupt again to force)
 ↓ |ios| e2e/todos.e2e.ts (1 test | 1 skipped)
 ❯ |ios| e2e/sign-in.e2e.ts (3 tests | 1 interrupted) 32.93s
   ✓ invalid email and short password show field errors 19.88s
   × valid credentials land on todos (interrupted) 83ms
 ❯ |ios| e2e/todo-detail.e2e.ts (2 tests | 1 failed | 1 skipped) 14.01s
   × open a todo, mark it done, then delete it 14.01s
`;

describe("flowMarks", () => {
	test("file-level ✓ = passed, ❯ with a failure = failed; skipped and test-level lines mark nothing", () => {
		expect(flowMarks(RUN, flows)).toEqual({
			onboarding: "passed",
			settings: "passed",
			"sign-in": "failed",
			"todo-detail": "failed",
		});
	});

	test("warden's line stamps are ignored", () => {
		const stamped = RUN.split("\n")
			.map((line) => `[23:51:23.412] ${line}`)
			.join("\n");
		expect(flowMarks(stamped, flows)).toEqual(flowMarks(RUN, flows));
		expect(flowMarks(stamped, flows)).toHaveProperty("onboarding", "passed");
	});

	test("nothing finished yet → no marks", () => {
		expect(flowMarks(" RUN  e2e v0.19.0\nℹ booting X (1 of 2)\n", flows)).toEqual({});
	});

	test("ANSI colour is ignored", () => {
		expect(flowMarks("\u001b[32m ✓\u001b[39m |ios| e2e/todos.e2e.ts (1 test) 3s\n", flows)).toEqual({
			todos: "passed",
		});
	});

	test("a path only matches whole: todos does not match todos-extra, detail does not match todo-detail", () => {
		const out = " ✓ |ios| e2e/todos-extra.e2e.ts (1 test)\n ✓ |ios| e2e/todo-detail.e2e.ts (1 test)\n";
		expect(flowMarks(out, [...flows, { id: "detail", path: "detail.e2e.ts" }])).toEqual({ "todo-detail": "passed" });
	});

	test("a file-level × is a failure; the last line for a flow wins (retries)", () => {
		const out = " × |ios| e2e/todos.e2e.ts (1 test | 1 failed)\n ✓ |ios| e2e/todos.e2e.ts (1 test) 2s\n";
		expect(flowMarks(out, flows)).toEqual({ todos: "passed" });
		expect(flowMarks(" × |ios| e2e/todos.e2e.ts\n", flows)).toEqual({ todos: "failed" });
	});
});
