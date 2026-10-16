import { basename, relative } from "node:path";
import { readResults, type TestResult as WardenTestResult } from "@delacour/warden-e2e/runner/results";
import { readTrace, type TraceEvent } from "@delacour/warden-e2e/runner/trace";
import type { StepResult, TestResult } from "../../results/schema";

/** One test from `results.jsonl`, before the manifest maps its name to a canonical id. */
export type WardenNative = {
	nativeName: string;
	status: TestResult["status"];
	durationMs: number;
	error?: string;
	steps: StepResult[];
	/** test wall time no step and no span of its `trace.jsonl` covers; undefined without a readable trace */
	untracedMs?: number;
	artifacts: NonNullable<TestResult["artifacts"]>;
};

/** `onboarding.e2e.ts › onboarding steps through to sign-in`: what the spec reporter prints, minus the path. */
export function nativeNameOf(file: string, title: readonly string[]): string {
	return `${basename(file)} › ${title.join(" › ")}`;
}

/** `step-end` events become steps; a step-start without an end (a killed run) has no duration and is dropped. */
export function stepsFromTrace(events: readonly TraceEvent[]): StepResult[] {
	const steps: StepResult[] = [];
	for (const event of events) {
		if (event.type === "step-end")
			steps.push({ kind: event.kind, label: event.label, ms: event.ms, status: event.status });
	}
	return steps;
}

type Interval = readonly [start: number, end: number];

/** The time a trace event accounts for: a finished step ended at `ts` and took `ms`, a span started at `ts` and took `ms`. */
function intervalOf(event: TraceEvent): Interval | undefined {
	if (event.type === "step-end") return [event.ts - event.ms, event.ts];
	if (event.type === "span") return [event.ts, event.ts + event.ms];
	return undefined;
}

/**
 * Test wall time that no step and no span covers: `durationMs` minus the length of the union of every `step-end`
 * and `span` interval clipped to the test (`startedAt` .. `startedAt + durationMs`). Nested steps and spans (a
 * `device.settle` around a `driver.settle`) count once. What is left is time the trace cannot explain: runner
 * overhead, hooks, sleeps and any call nobody wrapped.
 */
export function untracedMsOf(events: readonly TraceEvent[], test: { startedAt: number; durationMs: number }): number {
	const from = test.startedAt;
	const to = test.startedAt + test.durationMs;
	const clipped: Interval[] = [];
	for (const event of events) {
		const interval = intervalOf(event);
		if (interval === undefined) continue;
		const start = Math.max(from, interval[0]);
		const end = Math.min(to, interval[1]);
		if (end > start) clipped.push([start, end]);
	}
	clipped.sort((a, b) => a[0] - b[0]);
	let covered = 0;
	let runEnd = from;
	for (const [start, end] of clipped) {
		if (end <= runEnd) continue;
		covered += end - Math.max(start, runEnd);
		runEnd = end;
	}
	return Math.max(0, test.durationMs - covered);
}

function artifactKind(file: string): NonNullable<TestResult["artifacts"]>[number]["kind"] | undefined {
	if (file.endsWith(".png")) return "screenshot";
	if (file.endsWith(".mp4") || file.endsWith(".mov")) return "video";
	if (file.endsWith(".jsonl") || file.endsWith(".json")) return "json";
	if (file.endsWith(".txt") || file.endsWith(".log")) return "log";
	return undefined;
}

/** The files of the attempt dir as artifacts, with paths relative to `relativeTo` (the rep's out dir). */
function artifactsOf(result: WardenTestResult, relativeTo: string): WardenNative["artifacts"] {
	const found = result.artifacts;
	if (found === undefined) return [];
	const out: WardenNative["artifacts"] = [];
	for (const file of found.files) {
		const kind = artifactKind(file);
		if (kind === undefined) continue;
		out.push({ kind, path: relative(relativeTo, `${found.dir}/${file}`) });
	}
	return out;
}

/**
 * `results.jsonl` text → native tests. Steps (`step-end` events only: spans are not steps) and `untracedMs` come
 * from each attempt's `trace.jsonl`, fetched through `readText` (undefined when the file is missing). Truncated or
 * invalid lines are skipped by `readResults`.
 */
export function parseWardenResults(
	text: string,
	readText: (path: string) => string | undefined,
	relativeTo: string
): WardenNative[] {
	return readResults(text).map((result) => {
		const traceText = result.artifacts !== undefined ? readText(`${result.artifacts.dir}/trace.jsonl`) : undefined;
		const events = traceText !== undefined ? readTrace(traceText) : undefined;
		return {
			nativeName: nativeNameOf(result.file, result.title),
			status: result.status,
			durationMs: result.durationMs,
			...(result.error !== undefined ? { error: result.error.message } : {}),
			steps: events !== undefined ? stepsFromTrace(events) : [],
			...(events !== undefined ? { untracedMs: untracedMsOf(events, result) } : {}),
			artifacts: artifactsOf(result, relativeTo),
		};
	});
}
