import { describe, expect, test } from "bun:test";
import { flowSchema } from "./flow.schema";
import { migrateFlow } from "./migrate";

const header = {
	name: "old",
	createdAt: 1_700_000_000_000,
	recordedOn: { platform: "ios", device: "iPhone 16", screen: { width: 390, height: 844, scale: 3 } },
};
const at = (i: number) => ({ i, at: 1_700_000_000_000 + i });
const selector = {
	kind: "selector",
	selector: "id=row",
	chain: [{ by: "id", selector: "id=row" }],
	landmark: { role: "button", frame: { x: 0, y: 0, width: 10, height: 10 } },
};

const v1 = {
	v: 1,
	...header,
	steps: [
		{ ...at(0), kind: "rotate", orientation: "landscapeLeft" },
		{ ...at(1), kind: "appearance", mode: "dark", note: "dark" },
		{ ...at(2), kind: "screenshot", name: "shot", snapshotHash: "h" },
		{ ...at(3), kind: "swipe", gesture: { by: "direction", direction: "down", momentum: "fast", target: selector } },
		{ ...at(4), kind: "swipe", gesture: { by: "path", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 400 } },
		{ ...at(5), kind: "longpress", target: selector, durationMs: 800, settle: {} },
		{ ...at(6), kind: "press", target: selector },
	],
};

describe("migrateFlow", () => {
	test("renames every v1 kind to its v2 shape", () => {
		const flow = flowSchema.parse(migrateFlow(v1));
		expect(flow.v).toBe(2);
		expect<unknown>(flow.steps).toEqual([
			{ ...at(0), kind: "screen", type: "rotate", orientation: "landscapeLeft" },
			{ ...at(1), kind: "screen", type: "appearance", mode: "dark", note: "dark" },
			{ ...at(2), kind: "screen", type: "screenshot", name: "shot", snapshotHash: "h" },
			{
				...at(3),
				kind: "gesture",
				type: "swipe",
				by: "direction",
				direction: "down",
				momentum: "fast",
				target: selector,
			},
			{
				...at(4),
				kind: "gesture",
				type: "swipe",
				by: "path",
				from: { x: 1, y: 2 },
				to: { x: 3, y: 4 },
				durationMs: 400,
			},
			{ ...at(5), kind: "gesture", type: "longpress", target: selector, durationMs: 800, settle: {} },
			{ ...at(6), kind: "press", target: selector },
		]);
	});

	test("v2 passes through unchanged", () => {
		const v2 = { v: 2, ...header, steps: [{ ...at(0), kind: "screen", type: "rotate", orientation: "portrait" }] };
		expect(migrateFlow(v2)).toBe(v2);
	});

	test("unknown versions and non-objects are untouched", () => {
		const future = { v: 3, steps: [{ kind: "rotate" }] };
		expect(migrateFlow(future)).toBe(future);
		expect(migrateFlow("nope")).toBe("nope");
		expect(flowSchema.safeParse(migrateFlow(future)).success).toBe(false);
	});
});
