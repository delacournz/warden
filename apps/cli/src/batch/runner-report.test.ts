import { describe, expect, test } from "bun:test";
import { resultsTesting } from "./results.testing";
import { runnerReportHelpers } from "./runner-report";

const specs = ["onboarding", "sign-in", "todos"].map((id) => ({ id, path: `/app/e2e/${id}.e2e.ts` }));
const file = (id: string) => `/app/e2e/${id}.e2e.ts`;
const identity = (path: string) => path;
const on = (udid: string) => ({ device: { udid, platform: "ios" as const } });

const RUN = resultsTesting.jsonl(
	resultsTesting.result(file("onboarding"), "welcome", "passed", on("A")),
	resultsTesting.result(file("sign-in"), "valid", "passed", on("B")),
	resultsTesting.result(file("sign-in"), "invalid", "failed", on("B")),
	resultsTesting.result(file("sign-in"), "valid", "passed", on("A")),
	resultsTesting.result(file("todos"), "later", "skipped", on("A")),
	resultsTesting.result("/app/e2e/other.e2e.ts", "x", "passed", on("A"))
);

describe("resultsReport", () => {
	test("per spec: failed if any of its tests failed; per device: each spec it ran, failed if a test of it failed there", () => {
		expect(runnerReportHelpers.resultsReport(RUN, specs, 0, identity)).toEqual({
			specs: { onboarding: "passed", "sign-in": "failed", todos: "passed" },
			devices: {
				A: [
					{ id: "onboarding", mark: "passed" },
					{ id: "sign-in", mark: "passed" },
					{ id: "todos", mark: "passed" },
				],
				B: [{ id: "sign-in", mark: "failed" }],
			},
		});
	});

	test("a timed-out test fails its spec", () => {
		const text = resultsTesting.jsonl(resultsTesting.result(file("todos"), "slow", "timed-out"));
		expect(runnerReportHelpers.resultsReport(text, specs, 0, identity)?.specs).toEqual({ todos: "failed" });
	});

	test("results from before the run started are ignored", () => {
		expect(runnerReportHelpers.resultsReport(RUN, specs, 5_000, identity)).toBeUndefined();
	});

	test("empty, unparseable or all-untracked results → undefined; a truncated last line is skipped", () => {
		expect(runnerReportHelpers.resultsReport("", specs, 0, identity)).toBeUndefined();
		expect(runnerReportHelpers.resultsReport("nope\n", specs, 0, identity)).toBeUndefined();
		expect(
			runnerReportHelpers.resultsReport(
				resultsTesting.jsonl(resultsTesting.result("/app/e2e/other.e2e.ts", "x")),
				specs,
				0,
				identity
			)
		).toBeUndefined();
		const truncated = `${resultsTesting.jsonl(resultsTesting.result(file("todos"), "t"))}{"file":"`;
		expect(runnerReportHelpers.resultsReport(truncated, specs, 0, identity)?.specs).toEqual({ todos: "passed" });
	});
});

describe("resultsReport over retried attempts", () => {
	const first = resultsTesting.jsonl(
		resultsTesting.result(file("onboarding"), "welcome", "passed", on("A")),
		resultsTesting.result(file("sign-in"), "valid", "passed", on("A")),
		resultsTesting.result(file("sign-in"), "invalid", "failed", on("A"))
	);

	test("a spec that failed and then passed on the retry is passed: the last attempt decides", () => {
		const retry = resultsTesting.jsonl(
			resultsTesting.result(file("sign-in"), "valid", "passed", on("A")),
			resultsTesting.result(file("sign-in"), "invalid", "passed", on("A"))
		);
		expect(runnerReportHelpers.resultsReport([first, retry], specs, 0, identity)).toEqual({
			specs: { onboarding: "passed", "sign-in": "passed" },
			devices: {
				A: [
					{ id: "onboarding", mark: "passed" },
					{ id: "sign-in", mark: "passed" },
				],
			},
		});
	});

	test("a spec the retry did not run keeps its earlier mark", () => {
		const retry = resultsTesting.jsonl(resultsTesting.result(file("sign-in"), "invalid", "passed", on("A")));
		expect(runnerReportHelpers.resultsReport([first, retry], specs, 0, identity)?.specs).toEqual({
			onboarding: "passed",
			"sign-in": "passed",
		});
		const failedRetry = resultsTesting.jsonl(resultsTesting.result(file("sign-in"), "invalid", "failed", on("A")));
		expect(runnerReportHelpers.resultsReport([first, failedRetry], specs, 0, identity)?.specs["sign-in"]).toBe(
			"failed"
		);
	});

	test("a spec that passed and then failed on a later attempt is failed", () => {
		const passing = resultsTesting.jsonl(resultsTesting.result(file("todos"), "t", "passed", on("A")));
		const failing = resultsTesting.jsonl(resultsTesting.result(file("todos"), "t", "failed", on("A")));
		expect(runnerReportHelpers.resultsReport([passing, failing], specs, 0, identity)?.specs).toEqual({
			todos: "failed",
		});
	});

	test("a failure on one device is not undone by a pass on another (device legs)", () => {
		const onB = resultsTesting.jsonl(resultsTesting.result(file("sign-in"), "invalid", "passed", on("B")));
		const report = runnerReportHelpers.resultsReport([first, onB], specs, 0, identity);
		expect(report?.specs["sign-in"]).toBe("failed");
		expect(report?.devices).toEqual({
			A: [
				{ id: "onboarding", mark: "passed" },
				{ id: "sign-in", mark: "failed" },
			],
			B: [{ id: "sign-in", mark: "passed" }],
		});
	});

	test("attempts from before the run started are ignored, and an empty attempt changes nothing", () => {
		const stale = resultsTesting.jsonl(
			resultsTesting.result(file("todos"), "t", "failed", { ...on("A"), startedAt: 1 })
		);
		const fresh = resultsTesting.jsonl(
			resultsTesting.result(file("todos"), "t", "passed", { ...on("A"), startedAt: 9_000 })
		);
		expect(runnerReportHelpers.resultsReport([stale, fresh, ""], specs, 5_000, identity)?.specs).toEqual({
			todos: "passed",
		});
	});

	test("a single text is one attempt, as before", () => {
		expect(runnerReportHelpers.resultsReport(first, specs, 0, identity)).toEqual(
			runnerReportHelpers.resultsReport([first], specs, 0, identity)
		);
	});
});
