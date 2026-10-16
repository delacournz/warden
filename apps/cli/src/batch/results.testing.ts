import type { TestResult } from "@delacour/warden-e2e/runner/results";
import type { ReadFrom } from "./results-tail";

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

/** A `ReadFrom` over in-memory files (text or raw bytes); a path with no file rejects like a missing one. */
export function memoryReadFrom(files: ReadonlyMap<string, string | Uint8Array>): ReadFrom {
	return async (path, offset) => {
		const data = files.get(path);
		if (data === undefined) throw new Error(`ENOENT: ${path}`);
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		return { bytes: bytes.subarray(Math.min(offset, bytes.length)), size: bytes.length };
	};
}
