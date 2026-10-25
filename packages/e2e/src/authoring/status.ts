import { basename } from "node:path";
import { type LintFinding, lintRecording } from "./lint";
import type { RecordedStep, Recording, Target } from "./recording.schema";

/** What `record status` shows: how far the recording is, its last few steps in one line each, and the lints so far. */

export type StepSummary = { i: number; kind: RecordedStep["kind"]; summary: string };

export type RecordingStatus = {
	name: string;
	title: string | undefined;
	steps: number;
	last: StepSummary[];
	lints: LintFinding[];
};

const LAST_STEPS = 5;

function targetText(target: Target | undefined): string {
	if (target === undefined) return "";
	return target.kind === "selector" ? ` ${target.selector}` : ` @(${target.x}, ${target.y})`;
}

/** One line for a step: its kind (and type) plus what it acted on. Secrets stay names, never values. */
export function summarizeStep(step: RecordedStep): string {
	switch (step.kind) {
		case "note":
			return `note: ${step.text}`;
		case "open":
			return `open${step.url === undefined ? "" : ` ${step.url}`}`;
		case "use":
			return `use ${basename(step.module)}#${step.fn}`;
		case "fill":
		case "type": {
			const typed = typeof step.text === "string" ? JSON.stringify(step.text) : `$${step.text.secret}`;
			return `${step.kind}${targetText(step.target)} ${typed}`;
		}
		case "key":
			return `key ${step.key}${targetText(step.target)}`;
		case "scroll":
			return `scroll${step.direction === undefined ? "" : ` ${step.direction}`}${step.until === undefined ? "" : ` until${targetText(step.until)}`}`;
		case "wait":
		case "press":
			return `${step.kind}${targetText(step.target)}`;
		case "is":
			return `is${targetText(step.target)} ${step.not === true ? "not " : ""}${step.state}`;
		case "get":
			return `get ${step.property}${targetText(step.target)}`;
		case "alert":
			return `alert ${typeof step.action === "string" ? step.action : step.action.button}`;
		case "screen":
		case "gesture":
			return `${step.kind} ${step.type}${"target" in step ? targetText(step.target) : ""}`;
		default:
			return step.kind;
	}
}

export function recordingStatus(recording: Recording): RecordingStatus {
	return {
		name: recording.name,
		title: recording.title,
		steps: recording.steps.length,
		last: recording.steps
			.slice(-LAST_STEPS)
			.map((step) => ({ i: step.i, kind: step.kind, summary: summarizeStep(step) })),
		lints: lintRecording(recording),
	};
}
