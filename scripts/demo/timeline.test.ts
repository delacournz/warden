import { describe, expect, test } from "bun:test";
import type { DemoDefinition, RecordedTake } from "./demo.types";
import { buildPlan, computeTerminalLayout, maskSecrets, shownCommand, typeDuration } from "./timeline";

const def: DemoDefinition = {
	name: "t",
	title: "T",
	subtitle: "s",
	terminalTitle: "zsh",
	footer: { left: "l", right: "r" },
	platform: "ios",
	claim: {},
	app: { bundleId: "a.b", kind: "simulator", project: "apps/example" },
	ready: [],
	leadInMs: 1000,
	tailHoldMs: 2000,
	outro: "# done",
	steps: [
		{ argv: ["ui", "biometrics", "status"], output: { kind: "plain", text: "enrolled: true" }, pauseAfterMs: 1 },
		{ argv: ["ui", "press", "id=x"], hidden: true, output: { kind: "ok", text: "n/a" }, pauseAfterMs: 1 },
		{ argv: ["ui", "wait", "text", "Unlocked now"], output: { kind: "ok", text: "found" }, pauseAfterMs: 1 },
	],
};
const take: RecordedTake = {
	name: "t",
	udid: "u",
	recordedS: 9,
	steps: [
		{ index: 0, startS: 1.5, endS: 2.5 },
		{ index: 1, startS: 3, endS: 3.4 },
		{ index: 2, startS: 4, endS: 4.2 },
	],
};

function at<T>(items: readonly T[], i: number): T {
	const item = items[i];
	if (item === undefined) throw new Error(`no item ${i}`);
	return item;
}

describe("maskSecrets", () => {
	test("masks key=value, prefixed tokens and long hex", () => {
		expect(maskSecrets("password: hunter2 ok")).toBe("password: •••••••• ok");
		expect(maskSecrets("ghp_abcdefghijklmnopqrstuv")).toBe("••••••••");
		expect(maskSecrets("id 0123456789abcdef0123456789abcdef")).toBe("id ••••••••");
	});
	test("leaves plain text and short ids", () => {
		expect(maskSecrets("enrolled: true  modality: face")).toBe("enrolled: true  modality: face");
		expect(maskSecrets("warden ui press id=bio-unlock")).toBe("warden ui press id=bio-unlock");
	});
});

describe("shownCommand", () => {
	test("quotes args with spaces", () => {
		expect(shownCommand(at(def.steps, 2))).toBe('warden ui wait text "Unlocked now"');
	});
	test("honours shown override", () => {
		expect(shownCommand({ ...at(def.steps, 0), shown: "warden x" })).toBe("warden x");
	});
});

describe("buildPlan", () => {
	const plan = buildPlan(def, take, 8, "/fonts");
	test("skips hidden steps", () => expect(plan.steps).toHaveLength(2));
	test("output at step end, typing ends at fire", () => {
		const s = at(plan.steps, 0);
		expect(s.outputS).toBe(2.5);
		expect(s.typeStartS).toBeCloseTo(1.5 - typeDuration(s.shown), 5);
	});
	test("typing never starts before the previous output", () => {
		const s = at(plan.steps, 1);
		expect(s.typeStartS).toBeGreaterThanOrEqual(at(plan.steps, 0).outputS);
		expect(s.typeStartS).toBeLessThanOrEqual(s.fireS);
	});
	test("outro follows last output, duration holds the tail", () => {
		expect(plan.outroS).toBeCloseTo(5.0, 5);
		expect(plan.durationS).toBe(10);
	});
	test("phone caption defaults to the real-simulator note", () => {
		expect(plan.phoneCaption).toBe("real simulator · not an animation");
	});
	test("phone caption follows the definition", () => {
		expect(buildPlan({ ...def, phoneCaption: "recorded live" }, take, 8, "/f").phoneCaption).toBe("recorded live");
	});
	test("missing times throw", () => {
		expect(() => buildPlan(def, { ...take, steps: [] }, 8, "/f")).toThrow();
	});
});

describe("computeTerminalLayout", () => {
	test("five steps keep the full size", () => {
		const l = computeTerminalLayout(5);
		expect(l).toMatchObject({ entryPitch: 86, fontPx: 24, scroll: false });
	});
	test("shrinks when crowded", () => {
		const l = computeTerminalLayout(7);
		expect(l.scroll).toBe(false);
		expect(l.entryPitch * 7).toBeLessThanOrEqual(500);
	});
	test("scrolls past the legibility floor", () => {
		const l = computeTerminalLayout(14);
		expect(l.scroll).toBe(true);
		expect(l.visibleEntries).toBeLessThan(14);
		expect(l.fontPx).toBe(25);
	});
});
