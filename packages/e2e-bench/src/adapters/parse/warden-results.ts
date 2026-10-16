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
 * `results.jsonl` text → native tests. Steps come from each attempt's `trace.jsonl`, fetched through
 * `readText` (undefined when the file is missing). Truncated or invalid lines are skipped by `readResults`.
 */
export function parseWardenResults(
	text: string,
	readText: (path: string) => string | undefined,
	relativeTo: string
): WardenNative[] {
	return readResults(text).map((result) => {
		const traceText = result.artifacts !== undefined ? readText(`${result.artifacts.dir}/trace.jsonl`) : undefined;
		return {
			nativeName: nativeNameOf(result.file, result.title),
			status: result.status,
			durationMs: result.durationMs,
			...(result.error !== undefined ? { error: result.error.message } : {}),
			steps: traceText !== undefined ? stepsFromTrace(readTrace(traceText)) : [],
			artifacts: artifactsOf(result, relativeTo),
		};
	});
}
