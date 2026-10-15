import { describe, expect, test } from "bun:test";
import { reportOutputDir, runnerReport } from "./runner-report";

const flows = [
	{ id: "onboarding", path: "e2e/onboarding.e2e.ts" },
	{ id: "sign-in", path: "e2e/sign-in.e2e.ts" },
	{ id: "todos", path: "e2e/todos.e2e.ts" },
];

const attempt = (status: string, device: string) => ({ status, environment: { platform: "ios", device } });

/** The shape of tester.army `e2e run`'s `<output>/report.json` (fields warden reads). */
function report(startedAt: string, results: unknown[]): string {
	return JSON.stringify({ schemaVersion: "report-1", run: { startedAt, results } });
}

const RUN = report("2026-10-14T10:10:11.780Z", [
	{ file: "e2e/onboarding.e2e.ts", status: "passed", attempts: [attempt("passed", "A")] },
	{ file: "e2e/sign-in.e2e.ts", status: "passed", attempts: [attempt("passed", "B")] },
	{ file: "e2e/sign-in.e2e.ts", status: "failed", attempts: [attempt("failed", "B"), attempt("passed", "A")] },
	{ file: "e2e/todos.e2e.ts", status: "skipped", attempts: [] },
	{ file: "e2e/other.e2e.ts", status: "passed", attempts: [attempt("passed", "A")] },
]);
const SINCE = Date.parse("2026-10-14T10:10:00.000Z");

describe("runnerReport", () => {
	test("per flow: failed if any of its tests failed; per device: each flow it ran, failed if a test of it failed there", () => {
		expect(runnerReport(RUN, flows, SINCE)).toEqual({
			flows: { onboarding: "passed", "sign-in": "failed" },
			devices: {
				A: [
					{ id: "onboarding", mark: "passed" },
					{ id: "sign-in", mark: "passed" },
				],
				B: [{ id: "sign-in", mark: "failed" }],
			},
		});
	});

	test("an interrupted test is a failure", () => {
		const run = report("2026-10-14T10:10:11.780Z", [
			{ file: "e2e/todos.e2e.ts", status: "interrupted", attempts: [attempt("interrupted", "A")] },
		]);
		expect(runnerReport(run, flows, 0)).toEqual({
			flows: { todos: "failed" },
			devices: { A: [{ id: "todos", mark: "failed" }] },
		});
	});

	test("a report from an earlier run is ignored", () => {
		expect(runnerReport(RUN, flows, Date.parse("2026-10-14T11:00:00.000Z"))).toBeUndefined();
	});

	test("not JSON, or not that shape → undefined", () => {
		expect(runnerReport("nope", flows, 0)).toBeUndefined();
		expect(runnerReport(JSON.stringify({ run: {} }), flows, 0)).toBeUndefined();
	});
});

describe("reportOutputDir", () => {
	test("--output <dir> / --output=<dir>, else e2e's default .e2e; a placeholder means unknown", () => {
		expect(reportOutputDir(["bunx", "e2e", "run", "flows/a.yaml", "--output", ".e2e/dev"])).toBe(".e2e/dev");
		expect(reportOutputDir(["e2e", "run", "--output=out"])).toBe("out");
		expect(reportOutputDir(["bunx", "e2e", "run"])).toBe(".e2e");
		expect(reportOutputDir(["e2e", "run", "--output", "out/{worker}"])).toBeUndefined();
	});
});
