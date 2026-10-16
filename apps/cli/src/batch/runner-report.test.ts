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
