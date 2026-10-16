import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeNameOf, parseTesterReport, stepStatus, testStatus } from "./tester-report";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "../fixtures/tester-army", name), "utf8");

type StepIn = { api: string; label: string; status: string; durationMs: number };
type ResultIn = {
	kind?: string;
	titlePath: string[];
	status: string;
	attempts: Array<{ status: string; durationMs: number; steps?: StepIn[]; error?: { message: string } }>;
};

const report = (results: ResultIn[]): string =>
	JSON.stringify({
		schemaVersion: "report-1",
		run: {
			results: results.map((r) => ({
				kind: "test",
				...r,
				attempts: r.attempts.map((a) => ({
					steps: [],
					...a,
					...(a.steps ? { steps: a.steps.map((s) => ({ kind: "poll", ...s })) } : {}),
				})),
			})),
		},
	});

describe("testStatus / stepStatus", () => {
	test("flaky counts as passed; interrupted and unknown as failed", () => {
		expect(["passed", "flaky", "failed", "timed-out", "interrupted", "skipped", "weird"].map(testStatus)).toEqual([
			"passed",
			"passed",
			"failed",
			"timed-out",
			"failed",
			"skipped",
			"failed",
		]);
	});

	test("cancelled steps are skipped, blocked and timed-out failed", () => {
		expect(["passed", "cancelled", "blocked", "timed-out", "failed"].map(stepStatus)).toEqual([
			"passed",
			"skipped",
			"failed",
			"failed",
			"failed",
		]);
	});
});

describe("nativeNameOf", () => {
	test("joins describe and test titles with a space", () => {
		expect(nativeNameOf(["suite", "does a thing"])).toBe("suite does a thing");
	});
});

describe("parseTesterReport", () => {
	test("maps title, status, duration and steps of the last attempt", () => {
		const parsed = parseTesterReport(
			report([
				{
					titlePath: ["onboarding steps through to sign-in"],
					status: "passed",
					attempts: [
						{
							status: "passed",
							durationMs: 9100,
							steps: [
								{ api: "tap", label: "tap getByTestId(welcome-next)", status: "passed", durationMs: 700 },
								{ api: "toBeVisible", label: "expect visible", status: "failed", durationMs: 50 },
							],
						},
					],
				},
			])
		);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data).toEqual([
			{
				nativeName: "onboarding steps through to sign-in",
				status: "passed",
				durationMs: 9100,
				steps: [
					{ kind: "tap", label: "tap getByTestId(welcome-next)", ms: 700, status: "passed" },
					{ kind: "toBeVisible", label: "expect visible", ms: 50, status: "failed" },
				],
			},
		]);
	});

	test("a failed test carries the attempt error message", () => {
		const parsed = parseTesterReport(
			report([
				{
					titlePath: ["x"],
					status: "failed",
					attempts: [
						{ status: "failed", durationMs: 1, error: { message: "never found" } },
						{ status: "failed", durationMs: 2, error: { message: "still not found" } },
					],
				},
			])
		);
		expect(parsed.success && parsed.data[0]).toMatchObject({
			status: "failed",
			durationMs: 2,
			error: "still not found",
		});
	});

	test("setup results are not tests; a result with no attempts has duration 0", () => {
		const parsed = parseTesterReport(
			report([
				{ kind: "setup", titlePath: ["login"], status: "passed", attempts: [] },
				{ titlePath: ["skipped one"], status: "skipped", attempts: [] },
			])
		);
		expect(parsed.success && parsed.data).toEqual([
			{ nativeName: "skipped one", status: "skipped", durationMs: 0, steps: [] },
		]);
	});

	test("rejects non-JSON and a document that is not report-1", () => {
		expect(parseTesterReport("nope").success).toBe(false);
		const other = parseTesterReport(JSON.stringify({ schemaVersion: "report-2", run: { results: [] } }));
		expect(other.success).toBe(false);
	});
});

describe("parseTesterReport on a real e2e 0.20.0 report", () => {
	const parsed = parseTesterReport(fixture("report.json"));
	const tests = parsed.success ? parsed.data : [];

	test("8 passing tests in report order, titled exactly as the manifest names them", () => {
		expect(tests.map((t) => t.nativeName)).toEqual([
			"onboarding steps through to sign-in",
			"settings shows the account, toggles switches and signs out",
			"invalid email and short password show field errors",
			"a locked account shows the form alert",
			"valid credentials land on todos",
			"open a todo, mark it done, then delete it",
			"deep link opens a todo by id",
			"add, complete and filter todos",
		]);
		expect(tests.every((t) => t.status === "passed")).toBe(true);
	});

	test("durations are the attempt durations; steps keep api, label, ms and status", () => {
		expect(tests[0]?.durationMs).toBe(7553);
		expect(tests[0]?.steps.slice(0, 3)).toEqual([
			{ kind: "app.open", label: "", ms: 1089, status: "passed" },
			{ kind: "device.alert", label: "dismiss", ms: 2061, status: "failed" },
			{ kind: "expect.toBeVisible", label: 'getByTestId("welcome-screen")', ms: 309, status: "passed" },
		]);
	});

	test("a failed run keeps the assertion message on the failed test only", () => {
		const failedRun = parseTesterReport(fixture("report-failed.json"));
		const failed = failedRun.success ? failedRun.data.filter((t) => t.status === "failed") : [];
		expect(failed.map((t) => t.nativeName)).toEqual(["a locked account shows the form alert"]);
		expect(failed[0]?.error).toContain("sign-in-error");
	});
});
