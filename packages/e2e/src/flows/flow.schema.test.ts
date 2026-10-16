import { describe, expect, test } from "bun:test";
import { type Flow, flowSchema, type StepKind, stepSchema } from "./flow.schema";
import { allStepsFlow, flowOf } from "./flow.testing";

const KINDS: StepKind[] = [
	"open",
	"press",
	"longpress",
	"fill",
	"type",
	"key",
	"swipe",
	"scroll",
	"wait",
	"is",
	"get",
	"alert",
	"home",
	"back",
	"reload",
	"rotate",
	"appearance",
	"snapshot",
	"screenshot",
];

describe("flow schema", () => {
	test("the sample flow covers every step kind", () => {
		const kinds = new Set(allStepsFlow().steps.map((step) => step.kind));
		for (const kind of KINDS) expect(kinds.has(kind)).toBe(true);
		expect(kinds.size).toBe(KINDS.length);
	});

	test("round-trips through JSON unchanged", () => {
		const flow = allStepsFlow();
		const again = flowSchema.parse(JSON.parse(JSON.stringify(flow)));
		expect(again).toEqual(flow);
	});

	test("v must be 1", () => {
		const flow: unknown = { ...allStepsFlow(), v: 2 };
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
});
