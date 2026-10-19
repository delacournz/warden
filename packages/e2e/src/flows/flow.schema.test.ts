import { describe, expect, test } from "bun:test";
import { type Flow, flowSchema, type StepKey, stepKey, stepSchema } from "./flow.schema";
import { allStepsFlow, flowOf } from "./flow.testing";

const KEYS: StepKey[] = [
	"open",
	"press",
	"fill",
	"type",
	"key",
	"scroll",
	"wait",
	"is",
	"get",
	"alert",
	"home",
	"back",
	"reload",
	"snapshot",
	"screen.rotate",
	"screen.appearance",
	"screen.screenshot",
	"gesture.swipe",
	"gesture.longpress",
	"gesture.pinch",
	"gesture.rotate",
	"gesture.path",
];

const gesture = (fields: Record<string, unknown>) => stepSchema.safeParse({ i: 0, at: 1, kind: "gesture", ...fields });
const pt = (x: number, y: number) => ({ x, y });

describe("flow schema", () => {
	test("the sample flow covers every step kind", () => {
		const keys = new Set(allStepsFlow().steps.map(stepKey));
		for (const key of KEYS) expect(keys.has(key)).toBe(true);
		expect(keys.size).toBe(KEYS.length);
	});

	test("round-trips through JSON unchanged", () => {
		const flow = allStepsFlow();
		const again = flowSchema.parse(JSON.parse(JSON.stringify(flow)));
		expect(again).toEqual(flow);
	});

	test("v must be 2", () => {
		const flow: unknown = { ...allStepsFlow(), v: 1 };
		expect(flowSchema.safeParse(flow).success).toBe(false);
	});

	test("step indexes must equal their position", () => {
		const flow = flowOf([
			{ kind: "home", at: 1 },
			{ kind: "back", at: 2 },
		]);
		const broken: Flow = { ...flow, steps: [...flow.steps].reverse() };
		const result = flowSchema.safeParse(broken);
		expect(result.success).toBe(false);
	});

	test("unknown keys and unknown kinds are rejected", () => {
		expect(stepSchema.safeParse({ i: 0, at: 1, kind: "home", extra: true }).success).toBe(false);
		expect(stepSchema.safeParse({ i: 0, at: 1, kind: "teleport" }).success).toBe(false);
	});

	test("a target is a selector with a chain and landmark, or coordinates with a warning", () => {
		const press = (target: unknown) => stepSchema.safeParse({ i: 0, at: 1, kind: "press", target });
		expect(press({ kind: "coords", x: 1, y: 2 }).success).toBe(false);
		expect(press({ kind: "coords", x: 1, y: 2, warning: "w" }).success).toBe(true);
		expect(
			press({
				kind: "selector",
				selector: "id=a",
				chain: [],
				landmark: { role: "button", frame: { x: 0, y: 0, width: 1, height: 1 } },
			}).success
		).toBe(false);
	});

	test("text is a string or { secret }", () => {
		const fill = (text: unknown) =>
			stepSchema.safeParse({
				i: 0,
				at: 1,
				kind: "fill",
				text,
				target: { kind: "coords", x: 1, y: 2, warning: "w" },
			});
		expect(fill("plain").success).toBe(true);
		expect(fill({ secret: "PASSWORD" }).success).toBe(true);
		expect(fill({ secret: "" }).success).toBe(false);
		expect(fill({ value: "x" }).success).toBe(false);
	});

	test("a gesture path is one or two fingers of at least two points", () => {
		const finger = [pt(0, 0), pt(1, 1)];
		expect(gesture({ type: "path", paths: [finger] }).success).toBe(true);
		expect(gesture({ type: "path", paths: [finger, finger] }).success).toBe(true);
		expect(gesture({ type: "path", paths: [finger, finger, finger] }).success).toBe(false);
		expect(gesture({ type: "path", paths: [[pt(0, 0)]] }).success).toBe(false);
		expect(gesture({ type: "path", paths: [] }).success).toBe(false);
	});

	test("pinch needs a positive scale, rotate a non-zero finite angle", () => {
		expect(gesture({ type: "pinch", scale: 2 }).success).toBe(true);
		expect(gesture({ type: "pinch", scale: 0 }).success).toBe(false);
		expect(gesture({ type: "pinch", scale: -1 }).success).toBe(false);
		expect(gesture({ type: "rotate", degrees: -45 }).success).toBe(true);
		expect(gesture({ type: "rotate", degrees: 0 }).success).toBe(false);
		expect(gesture({ type: "rotate", degrees: Number.POSITIVE_INFINITY }).success).toBe(false);
	});

	test("a swipe is by direction or by path, never a mix", () => {
		expect(gesture({ type: "swipe", by: "direction", direction: "up" }).success).toBe(true);
		expect(gesture({ type: "swipe", by: "path", from: pt(0, 0), to: pt(1, 1) }).success).toBe(true);
		expect(gesture({ type: "swipe", by: "path", direction: "up" }).success).toBe(false);
		expect(gesture({ type: "swipe", by: "direction", direction: "up", from: pt(0, 0) }).success).toBe(false);
	});

	test("v1 kinds are gone from the schema", () => {
		expect(
			stepSchema.safeParse({ i: 0, at: 1, kind: "swipe", gesture: { by: "direction", direction: "up" } }).success
		).toBe(false);
		expect(stepSchema.safeParse({ i: 0, at: 1, kind: "rotate", orientation: "portrait" }).success).toBe(false);
	});
});
