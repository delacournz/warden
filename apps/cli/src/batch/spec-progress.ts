import { realpathSync } from "node:fs";
import { readResults, type TestResult } from "@delacour/warden-e2e/runner/results";

/** A spec finished inside a spec process, read off its `results.jsonl`. */
export type SpecMark = "passed" | "failed";

/**
 * A spec to look for: `path` is its spec file. `job` is the batch job that runs it when several
 * specs share one (`isolate: "device"`: `shard-<k>`), so the grid lists a device's shard only.
 */
export type TrackedSpec = { id: string; path: string; job?: string };

/** Resolves symlinks (macOS `/var` → `/private/var`); a path that does not exist is returned as is. */
export function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** A test that should fail its spec. */
export const failing = (result: TestResult): boolean => result.status === "failed" || result.status === "timed-out";

/** The tracked spec a result belongs to (same spec file once symlinks are resolved). */
export function specOf(
	result: TestResult,
	specs: readonly TrackedSpec[],
	real: (path: string) => string = realPath
): TrackedSpec | undefined {
	const file = real(result.file);
	return specs.find((f) => real(f.path) === file);
}

export type MarkOptions = {
	/** the process has exited: every spec with a result is finished */
	final?: boolean;
	real?: (path: string) => string;
};

/**
 * One process's results folded into per-spec marks as they arrive (see `resultsMarks` for the
 * rules). It keeps three facts, so adding a result is O(1): which specs have a result, which of them
 * failed, and which spec the latest result belongs to: bun runs a file's tests together, so every
 * other spec with a result is finished. `real` runs once per distinct path.
 */
export type SpecTracker = {
	/** the tracked spec a result belongs to */
	specOf: (result: TestResult) => TrackedSpec | undefined;
	/** fold in results, in file order */
	add: (results: readonly TestResult[]) => void;
	/** specs with a verdict so far; `final`: the process has exited */
	marks: (final?: boolean) => Record<string, SpecMark>;
	/** forget every result (the file was replaced) */
	reset: () => void;
};

export function specTracker(specs: readonly TrackedSpec[], real: (path: string) => string = realPath): SpecTracker {
	const resolved = new Map<string, string>();
	const resolve = (path: string): string => {
		const known = resolved.get(path);
		if (known !== undefined) return known;
		const target = real(path);
		resolved.set(path, target);
		return target;
	};
	const byFile = new Map<string, TrackedSpec>();
	for (const spec of specs) {
		const file = resolve(spec.path);
		if (!byFile.has(file)) byFile.set(file, spec);
	}
	const specFor = (result: TestResult) => byFile.get(resolve(result.file));
	const seen = new Set<string>();
	const failed = new Set<string>();
	let current: string | undefined;
	return {
		specOf: specFor,
		add(results) {
			for (const result of results) {
				const spec = specFor(result);
				if (!spec) continue;
				seen.add(spec.id);
				current = spec.id;
				if (failing(result)) failed.add(spec.id);
			}
		},
		marks(final = false) {
			const marks: Record<string, SpecMark> = {};
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
 * Per-spec results so far, from one process's `results.jsonl`. A spec with a failed / timed-out
 * test is `failed` at once. A spec is `passed` once it is finished: the process ended (`final`), or
 * a later result belongs to another file (bun runs a file's tests together, files one after the
 * other). Specs with no result yet, or still running, are absent. Truncated lines are ignored.
 */
export function resultsMarks(
	jsonl: string,
	specs: readonly TrackedSpec[],
	options: MarkOptions = {}
): Record<string, SpecMark> {
	const tracker = specTracker(specs, options.real);
	tracker.add(readResults(jsonl));
	return tracker.marks(options.final === true);
}

const SYMBOL: Record<TestResult["status"], string> = { passed: "✓", failed: "✗", "timed-out": "✗", skipped: "-" };

/** `✓ <spec> › <describe> › <title> (1.25s)`: one finished test, for the batch log. */
export function testLine(specId: string, result: TestResult): string {
	const secs = (result.durationMs / 1000).toFixed(2);
	return `${SYMBOL[result.status]} ${[specId, ...result.title].join(" › ")} (${secs}s)`;
}
