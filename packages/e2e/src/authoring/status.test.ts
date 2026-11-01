import { describe, expect, test } from "bun:test";
import { recordingFixtures } from "./recording.testing";
import { recordingStatusReader } from "./status";

describe("summarizeStep", () => {
	test("every step kind of the sample recording gets a non-empty one-line summary", () => {
		for (const step of recordingFixtures.allStepsRecording().steps) {
			const summary = recordingStatusReader.summarizeStep(step);
			expect(summary).not.toBe("");
			expect(summary).not.toContain("\n");
		}
	});

	test("a helper call shows the file and function, not the absolute path", () => {
		const [use] = recordingFixtures.recordingOf([
			{ kind: "use", at: 1, module: "/repo/e2e/helpers.ts", fn: "signIn" },
		]).steps;
		expect(use && recordingStatusReader.summarizeStep(use)).toBe("use helpers.ts#signIn");
	});

	test("says what was acted on, and keeps secrets as names", () => {
		const [press, fill, note] = recordingFixtures.recordingOf([
			{ kind: "press", at: 1, target: recordingFixtures.selectorTarget("id=go", "button") },
			{
				kind: "fill",
				at: 2,
				target: recordingFixtures.selectorTarget("id=pw", "textbox"),
				text: { secret: "PASSWORD" },
			},
			{ kind: "note", at: 3, text: "done" },
		]).steps;
		expect(press && recordingStatusReader.summarizeStep(press)).toBe("press id=go");
		expect(fill && recordingStatusReader.summarizeStep(fill)).toBe("fill id=pw $PASSWORD");
		expect(note && recordingStatusReader.summarizeStep(note)).toBe("note: done");
	});
});

describe("recordingStatus", () => {
	test("counts the steps, shows the last five and carries the lints", () => {
		const steps = Array.from({ length: 7 }, (_, n) => ({ kind: "home", at: n }) as const);
		const status = recordingStatusReader.recordingStatus(recordingFixtures.recordingOf(steps, { title: "Go home" }));
		expect(status).toMatchObject({ name: "sign in", title: "Go home", steps: 7 });
		expect(status.last.map((step) => step.i)).toEqual([2, 3, 4, 5, 6]);
		expect(status.lints).toEqual([]);
	});

	test("an empty recording reports its lint", () => {
		expect(
			recordingStatusReader.recordingStatus(recordingFixtures.recordingOf([])).lints.map((lint) => lint.code)
		).toEqual(["empty_recording"]);
	});
});
