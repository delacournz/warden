import { describe, expect, test } from "bun:test";
import { jsonl, result } from "./results.testing";
import { resultsReport } from "./runner-report";

const flows = ["onboarding", "sign-in", "todos"].map((id) => ({ id, path: `/app/e2e/${id}.e2e.ts` }));
const file = (id: string) => `/app/e2e/${id}.e2e.ts`;
const identity = (path: string) => path;
const on = (udid: string) => ({ device: { udid, platform: "ios" as const } });

const RUN = jsonl(
	result(file("onboarding"), "welcome", "passed", on("A")),
	result(file("sign-in"), "valid", "passed", on("B")),
	result(file("sign-in"), "invalid", "failed", on("B")),
	result(file("sign-in"), "valid", "passed", on("A")),
	result(file("todos"), "later", "skipped", on("A")),
	result("/app/e2e/other.e2e.ts", "x", "passed", on("A"))
);

describe("resultsReport", () => {
	test("per flow: failed if any of its tests failed; per device: each flow it ran, failed if a test of it failed there", () => {
		expect(resultsReport(RUN, flows, 0, identity)).toEqual({
			flows: { onboarding: "passed", "sign-in": "failed", todos: "passed" },
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

	test("a timed-out test fails its flow", () => {
		const text = jsonl(result(file("todos"), "slow", "timed-out"));
		expect(resultsReport(text, flows, 0, identity)?.flows).toEqual({ todos: "failed" });
	});

	test("results from before the run started are ignored", () => {
		expect(resultsReport(RUN, flows, 5_000, identity)).toBeUndefined();
	});

	test("empty, unparseable or all-untracked results → undefined; a truncated last line is skipped", () => {
		expect(resultsReport("", flows, 0, identity)).toBeUndefined();
		expect(resultsReport("nope\n", flows, 0, identity)).toBeUndefined();
		expect(resultsReport(jsonl(result("/app/e2e/other.e2e.ts", "x")), flows, 0, identity)).toBeUndefined();
		const truncated = `${jsonl(result(file("todos"), "t"))}{"file":"`;
		expect(resultsReport(truncated, flows, 0, identity)?.flows).toEqual({ todos: "passed" });
	});
});

describe("resultsReport over retried attempts", () => {
	const first = jsonl(
		result(file("onboarding"), "welcome", "passed", on("A")),
		result(file("sign-in"), "valid", "passed", on("A")),
		result(file("sign-in"), "invalid", "failed", on("A"))
	);

	test("a flow that failed and then passed on the retry is passed: the last attempt decides", () => {
		const retry = jsonl(
			result(file("sign-in"), "valid", "passed", on("A")),
			result(file("sign-in"), "invalid", "passed", on("A"))
		);
		expect(resultsReport([first, retry], flows, 0, identity)).toEqual({
			flows: { onboarding: "passed", "sign-in": "passed" },
			devices: {
				A: [
					{ id: "onboarding", mark: "passed" },
					{ id: "sign-in", mark: "passed" },
				],
			},
		});
	});

	test("a flow the retry did not run keeps its earlier mark", () => {
		const retry = jsonl(result(file("sign-in"), "invalid", "passed", on("A")));
		expect(resultsReport([first, retry], flows, 0, identity)?.flows).toEqual({
			onboarding: "passed",
			"sign-in": "passed",
		});
		const failedRetry = jsonl(result(file("sign-in"), "invalid", "failed", on("A")));
		expect(resultsReport([first, failedRetry], flows, 0, identity)?.flows["sign-in"]).toBe("failed");
	});

	test("a flow that passed and then failed on a later attempt is failed", () => {
		const passing = jsonl(result(file("todos"), "t", "passed", on("A")));
		const failing = jsonl(result(file("todos"), "t", "failed", on("A")));
		expect(resultsReport([passing, failing], flows, 0, identity)?.flows).toEqual({ todos: "failed" });
	});

	test("a failure on one device is not undone by a pass on another (device legs)", () => {
		const onB = jsonl(result(file("sign-in"), "invalid", "passed", on("B")));
		const report = resultsReport([first, onB], flows, 0, identity);
		expect(report?.flows["sign-in"]).toBe("failed");
		expect(report?.devices).toEqual({
			A: [
				{ id: "onboarding", mark: "passed" },
				{ id: "sign-in", mark: "failed" },
			],
			B: [{ id: "sign-in", mark: "passed" }],
		});
	});

	test("attempts from before the run started are ignored, and an empty attempt changes nothing", () => {
		const stale = jsonl(result(file("todos"), "t", "failed", { ...on("A"), startedAt: 1 }));
		const fresh = jsonl(result(file("todos"), "t", "passed", { ...on("A"), startedAt: 9_000 }));
		expect(resultsReport([stale, fresh, ""], flows, 5_000, identity)?.flows).toEqual({ todos: "passed" });
	});

	test("a single text is one attempt, as before", () => {
		expect(resultsReport(first, flows, 0, identity)).toEqual(resultsReport([first], flows, 0, identity));
	});
});
