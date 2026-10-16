import { realpathSync } from "node:fs";
import { readResults, type TestResult } from "@delacour/warden-e2e/runner/results";

/** A flow finished inside a spec process, read off its `results.jsonl`. */
export type FlowMark = "passed" | "failed";

/**
 * A flow to look for: `path` is its spec file. `job` is the batch job that runs it when several
 * flows share one (`mode: "single"`: `shard-<k>`), so the grid lists a device's shard only.
 */
export type TrackedFlow = { id: string; path: string; job?: string };

/** Resolves symlinks (macOS `/var` → `/private/var`); a path that does not exist is returned as is. */
export function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** A test that should fail its flow. */
export const failing = (result: TestResult): boolean => result.status === "failed" || result.status === "timed-out";

/** The tracked flow a result belongs to (same spec file once symlinks are resolved). */
export function flowOf(
	result: TestResult,
	flows: readonly TrackedFlow[],
	real: (path: string) => string = realPath
): TrackedFlow | undefined {
	const file = real(result.file);
	return flows.find((f) => real(f.path) === file);
}

export type MarkOptions = {
	/** the process has exited: every flow with a result is finished */
	final?: boolean;
	real?: (path: string) => string;
};

/**
 * Per-flow results so far, from one process's `results.jsonl`. A flow with a failed / timed-out
 * test is `failed` at once. A flow is `passed` once it is finished: the process ended (`final`), or
 * a later result belongs to another file (bun runs a file's tests together, files one after the
 * other). Flows with no result yet, or still running, are absent. Truncated lines are ignored.
 */
export function resultsMarks(
	jsonl: string,
	flows: readonly TrackedFlow[],
	options: MarkOptions = {}
): Record<string, FlowMark> {
	const real = options.real ?? realPath;
	const results = readResults(jsonl);
	const owners = results.map((r) => flowOf(r, flows, real)?.id);
	const marks: Record<string, FlowMark> = {};
	const last = new Map<string, number>();
	results.forEach((result, i) => {
		const id = owners[i];
		if (id === undefined) return;
		last.set(id, i);
		if (failing(result)) marks[id] = "failed";
	});
	for (const [id, at] of last) {
		if (marks[id]) continue;
		const finished = options.final === true || owners.slice(at + 1).some((o) => o !== undefined && o !== id);
		if (finished) marks[id] = "passed";
	}
	return marks;
}

const SYMBOL: Record<TestResult["status"], string> = { passed: "✓", failed: "✗", "timed-out": "✗", skipped: "-" };

/** `✓ <flow> › <describe> › <title> (1.25s)`: one finished test, for the batch log. */
export function testLine(flowId: string, result: TestResult): string {
	const secs = (result.durationMs / 1000).toFixed(2);
	return `${SYMBOL[result.status]} ${[flowId, ...result.title].join(" › ")} (${secs}s)`;
}
