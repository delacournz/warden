import { realpathSync } from "node:fs";
import { readResults, type TestResult } from "@delacour/warden-e2e/runner/results";

/** A flow finished inside a spec process, read off its `results.jsonl`. */
export type FlowMark = "passed" | "failed";

/**
 * A flow to look for: `path` is its spec file. `job` is the batch job that runs it when several
 * flows share one (`isolate: "device"`: `shard-<k>`), so the grid lists a device's shard only.
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
 * One process's results folded into per-flow marks as they arrive (see `resultsMarks` for the
 * rules). It keeps three facts, so adding a result is O(1): which flows have a result, which of them
 * failed, and which flow the latest result belongs to: bun runs a file's tests together, so every
 * other flow with a result is finished. `real` runs once per distinct path.
 */
export type FlowTracker = {
	/** the tracked flow a result belongs to */
	flowOf: (result: TestResult) => TrackedFlow | undefined;
	/** fold in results, in file order */
	add: (results: readonly TestResult[]) => void;
	/** flows with a verdict so far; `final`: the process has exited */
	marks: (final?: boolean) => Record<string, FlowMark>;
	/** forget every result (the file was replaced) */
	reset: () => void;
};

export function flowTracker(flows: readonly TrackedFlow[], real: (path: string) => string = realPath): FlowTracker {
	const resolved = new Map<string, string>();
	const resolve = (path: string): string => {
		const known = resolved.get(path);
		if (known !== undefined) return known;
		const target = real(path);
		resolved.set(path, target);
		return target;
	};
	const byFile = new Map<string, TrackedFlow>();
	for (const flow of flows) {
		const file = resolve(flow.path);
		if (!byFile.has(file)) byFile.set(file, flow);
	}
	const flowFor = (result: TestResult) => byFile.get(resolve(result.file));
	const seen = new Set<string>();
	const failed = new Set<string>();
	let current: string | undefined;
	return {
		flowOf: flowFor,
		add(results) {
			for (const result of results) {
				const flow = flowFor(result);
				if (!flow) continue;
				seen.add(flow.id);
				current = flow.id;
				if (failing(result)) failed.add(flow.id);
			}
		},
		marks(final = false) {
			const marks: Record<string, FlowMark> = {};
			for (const id of seen) {
				if (failed.has(id)) marks[id] = "failed";
				else if (final || id !== current) marks[id] = "passed";
			}
			return marks;
		},
		reset() {
			seen.clear();
			failed.clear();
			current = undefined;
		},
	};
}

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
	const tracker = flowTracker(flows, options.real);
	tracker.add(readResults(jsonl));
	return tracker.marks(options.final === true);
}

const SYMBOL: Record<TestResult["status"], string> = { passed: "✓", failed: "✗", "timed-out": "✗", skipped: "-" };

/** `✓ <flow> › <describe> › <title> (1.25s)`: one finished test, for the batch log. */
export function testLine(flowId: string, result: TestResult): string {
	const secs = (result.durationMs / 1000).toFixed(2);
	return `${SYMBOL[result.status]} ${[flowId, ...result.title].join(" › ")} (${secs}s)`;
}
