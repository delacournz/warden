import type { TestResult } from "@delacour/warden-e2e/runner/results";

/** A `TestResult` with the fields a test cares about; the rest is filled in. */
export function result(
	file: string,
	title: string,
	status: TestResult["status"] = "passed",
	extra: Partial<TestResult> = {}
): TestResult {
	return {
		file,
		title: [title],
		status,
		durationMs: 1250,
		startedAt: 1_000,
		device: { udid: "A", platform: "ios" },
		...extra,
	};
}

/** `results.jsonl` text of these results. */
export const jsonl = (...results: TestResult[]): string => `${results.map((r) => JSON.stringify(r)).join("\n")}\n`;
