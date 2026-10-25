import { describe, expect, test } from "bun:test";
import { type LintFinding, lintRecording } from "./lint";
import type { NewStep } from "./recording.schema";
import { allStepsRecording, recordingOf, selectorTarget } from "./recording.testing";

const press = (selector: string, extra: { snapshotHash?: string; matches?: number } = {}): NewStep => {
	const target = selectorTarget(selector, "button");
	return {
		kind: "press",
		at: 1,
		target: target.kind === "selector" && extra.matches !== undefined ? { ...target, matches: extra.matches } : target,
		...(extra.snapshotHash !== undefined && { snapshotHash: extra.snapshotHash }),
	};
};
const wait = (selector = "id=home"): NewStep => ({ kind: "wait", at: 2, target: selectorTarget(selector, "other") });

const codes = (findings: readonly LintFinding[]): string[] =>
	findings.map((finding) => `${finding.step}:${finding.code}`);
const lint = (...steps: NewStep[]): LintFinding[] => lintRecording(recordingOf(steps));

describe("use steps", () => {
	const use: NewStep = { kind: "use", at: 1, module: "/repo/e2e/helpers.ts", fn: "signIn" };

	test("a helper call followed by an action without a landmark check is an unverified navigation", () => {
		expect(codes(lint(use, press("id=add")))).toEqual(["0:unverified_navigation"]);
	});

	test("a wait after the helper call satisfies it", () => {
		expect(codes(lint(use, wait(), press("id=add")))).toEqual([]);
	});

	test("a helper call last in the recording is not flagged", () => {
		expect(codes(lint(press("id=a"), use))).toEqual([]);
	});
});

describe("lintRecording", () => {
	test("an empty recording, or one of only notes, is an error about the whole recording", () => {
		for (const steps of [[], [{ kind: "note", at: 1, text: "thinking" } satisfies NewStep]]) {
			const findings = lint(...steps);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({ level: "error", step: null, code: "empty_recording" });
			expect(findings[0]?.hint).not.toBe("");
		}
	});

	test("a coordinate target is an error with a hint to add a testID", () => {
		const findings = lint({ kind: "press", at: 1, target: { kind: "coords", x: 5, y: 6, warning: "by hand" } });
		expect(codes(findings)).toEqual(["0:coords_target"]);
		expect(findings[0]).toMatchObject({ level: "error" });
		expect(findings[0]?.hint).toContain("testID");
	});

	test("typing and key presses without a target are errors too", () => {
		expect(codes(lint({ kind: "type", at: 1, text: "x" }, { kind: "key", at: 2, key: "Escape" }))).toEqual([
			"0:coords_target",
			"1:coords_target",
		]);
	});

	test("a coordinate scroll --until target is found as well", () => {
		const findings = lint({
			kind: "scroll",
			at: 1,
			until: { kind: "coords", x: 1, y: 2, warning: "w" },
		});
		expect(codes(findings)).toEqual(["0:coords_target"]);
	});

	test("a selector without an id is a text_only_selector warning; one with an id is clean", () => {
		expect(codes(lint(press('label="Sign in" role=button')))).toEqual(["0:text_only_selector"]);
		expect(lint(press("id=sign-in-submit"))).toEqual([]);
		const findings = lint(press("text=Save"));
		expect(findings[0]).toMatchObject({ level: "warn" });
		expect(findings[0]?.hint).toContain("testID");
	});

	test("a selector that matched several elements is an ambiguous_selector warning", () => {
		expect(codes(lint(press("id=row nth=1", { matches: 3 })))).toEqual(["0:ambiguous_selector"]);
	});

	test("a press that changed the screen and is followed by another action is unverified_navigation", () => {
		const findings = lint(press("id=next", { snapshotHash: "a" }), {
			kind: "fill",
			at: 2,
			target: selectorTarget("id=name", "textbox"),
			text: "x",
			snapshotHash: "b",
		});
		expect(codes(findings)).toEqual(["0:unverified_navigation"]);
		expect(findings[0]).toMatchObject({ level: "warn" });
	});

	test("a wait, is or get after the navigation clears it, and so does an unchanged screen", () => {
		const fill: NewStep = {
			kind: "fill",
			at: 3,
			target: selectorTarget("id=name", "textbox"),
			text: "x",
			snapshotHash: "b",
		};
		expect(lint(press("id=next", { snapshotHash: "a" }), wait(), fill)).toEqual([]);
		expect(lint(press("id=next", { snapshotHash: "a" }), { ...fill, snapshotHash: "a" })).toEqual([]);
		expect(lint(press("id=next", { snapshotHash: "a" }), { ...fill, snapshotHash: undefined })).toEqual([]);
	});

	test("notes and snapshots between a navigation and its landmark do not hide or cause a finding", () => {
		expect(
			lint(
				press("id=next", { snapshotHash: "a" }),
				{ kind: "note", at: 2, text: "now on step two" },
				{ kind: "snapshot", at: 3 },
				wait()
			)
		).toEqual([]);
	});

	test("an open followed straight by an action is unverified_navigation; the last step never is", () => {
		const fill: NewStep = { kind: "fill", at: 2, target: selectorTarget("id=name", "textbox"), text: "x" };
		expect(codes(lint({ kind: "open", at: 1 }, fill))).toEqual(["0:unverified_navigation"]);
		expect(lint({ kind: "open", at: 1 })).toEqual([]);
	});

	test("findings come out in step order, whole-recording findings first", () => {
		const findings = lintRecording(allStepsRecording());
		const order = findings.map((finding) => finding.step ?? -1);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(findings.some((finding) => finding.code === "coords_target")).toBe(true);
	});

	test("is deterministic", () => {
		expect(lintRecording(allStepsRecording())).toEqual(lintRecording(allStepsRecording()));
	});
});
