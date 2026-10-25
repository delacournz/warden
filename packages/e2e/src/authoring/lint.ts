import { parseSelector } from "../screen/selector";
import type { RecordedStep, Recording, Target } from "./recording.schema";

/**
 * Lint a recording before it becomes a spec: what would make the generated test flaky, fail on its first run, or
 * not say what it checks. Pure; the same recording always yields the same findings, in step order.
 */

export type LintLevel = "warn" | "error";

export type LintCode =
	| "coords_target"
	| "text_only_selector"
	| "unverified_navigation"
	| "ambiguous_selector"
	| "empty_recording";

export type LintFinding = {
	level: LintLevel;
	/** index of the step the finding is about; null for the whole recording */
	step: number | null;
	code: LintCode;
	message: string;
	hint: string;
};

/** Steps that read the screen without changing it: they do not count as an action after a navigation. */
const NEUTRAL_KINDS: ReadonlySet<RecordedStep["kind"]> = new Set(["note", "snapshot"]);
const CHECK_KINDS: ReadonlySet<RecordedStep["kind"]> = new Set(["wait", "is", "get"]);
/** Steps after which the next screen is expected to differ. */
const NAVIGATING_KINDS: ReadonlySet<RecordedStep["kind"]> = new Set(["press", "open", "back", "use"]);

function isNeutral(step: RecordedStep): boolean {
	return NEUTRAL_KINDS.has(step.kind) || (step.kind === "screen" && step.type === "screenshot");
}

/** The targets a step resolves: its own, and a `scroll --until` one. */
function targetsOf(step: RecordedStep): Target[] {
	const targets: Target[] = [];
	if ("target" in step && step.target !== undefined) targets.push(step.target);
	if (step.kind === "scroll" && step.until !== undefined) targets.push(step.until);
	return targets;
}

/** Steps that need an element to act on: without one codegen can only emit a throwing FIXME. */
function needsTarget(step: RecordedStep): boolean {
	return (step.kind === "type" || step.kind === "key") && step.target === undefined;
}

function targetFindings(step: RecordedStep): LintFinding[] {
	const findings: LintFinding[] = [];
	for (const target of targetsOf(step)) {
		if (target.kind === "coords") {
			findings.push({
				level: "error",
				step: step.i,
				code: "coords_target",
				message: `step ${step.i} (${step.kind}) targets coordinates (${target.x}, ${target.y}); ${target.warning}`,
				hint: "Give the element a testID (and accessible) in the component, reload, undo this step and redo it by selector.",
			});
			continue;
		}
		const parsed = parseSelector(target.selector);
		if (!parsed.success || parsed.data.id === undefined) {
			findings.push({
				level: "warn",
				step: step.i,
				code: "text_only_selector",
				message: `step ${step.i} (${step.kind}) finds its element by ${target.selector}, not by test id`,
				hint: "Add a testID (and accessible) to the component, reload, undo this step and redo it by id: copy changes break text selectors.",
			});
		}
		if (target.matches !== undefined) {
			findings.push({
				level: "warn",
				step: step.i,
				code: "ambiguous_selector",
				message: `step ${step.i} (${step.kind}) matched ${target.matches} elements; it is pinned by position (${target.selector})`,
				hint: "Give the element a unique testID so the spec does not depend on list order.",
			});
		}
	}
	if (needsTarget(step)) {
		findings.push({
			level: "error",
			step: step.i,
			code: "coords_target",
			message: `step ${step.i} (${step.kind}) was recorded without a target element`,
			hint: "Target a field by testID (fill/press/type with a selector) so the spec knows where the input goes.",
		});
	}
	return findings;
}

/** A navigating step followed straight by another action: nothing says the new screen arrived. */
function navigationFindings(steps: readonly RecordedStep[]): LintFinding[] {
	const findings: LintFinding[] = [];
	const acting = steps.filter((step) => !isNeutral(step));
	acting.forEach((step, position) => {
		const next = acting[position + 1];
		if (!NAVIGATING_KINDS.has(step.kind) || next === undefined || CHECK_KINDS.has(next.kind)) return;
		const changed =
			step.kind === "open" ||
			step.kind === "use" ||
			step.kind === "back" ||
			(step.snapshotHash !== undefined && next.snapshotHash !== undefined && step.snapshotHash !== next.snapshotHash);
		if (!changed) return;
		findings.push({
			level: "warn",
			step: step.i,
			code: "unverified_navigation",
			message: `step ${step.i} (${step.kind}) changed the screen and step ${next.i} (${next.kind}) acts without waiting for it`,
			hint: "After every navigation `wait` for a testID that only the new screen has, so the spec fails here and not three steps later.",
		});
	});
	return findings;
}

export function lintRecording(recording: Recording): LintFinding[] {
	if (recording.steps.every((step) => step.kind === "note")) {
		return [
			{
				level: "error",
				step: null,
				code: "empty_recording",
				message: "the recording has no steps",
				hint: "Drive the app with `warden ui` actions after `record start`; notes alone produce no test.",
			},
		];
	}
	const findings = [...recording.steps.flatMap(targetFindings), ...navigationFindings(recording.steps)];
	return findings.sort((a, b) => (a.step ?? -1) - (b.step ?? -1));
}
