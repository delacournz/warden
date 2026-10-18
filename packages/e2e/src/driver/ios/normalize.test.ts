import { describe, expect, test } from "bun:test";
import { normalizeElement, normalizeElements, toSnapshot } from "./normalize";
import type { WireElement } from "./simd-protocol";

const screen = { width: 400, height: 800, scale: 2 };
const frame = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

const tree: WireElement[] = [
	{
		role: "window",
		rawType: "Window",
		frame: frame(0, 0, 400, 800),
		children: [
			{ role: "button", rawType: "Button", identifier: "go", frame: frame(40, 80, 200, 80) },
			{
				role: "list",
				rawType: "Table",
				frame: frame(0, 200, 400, 400),
				children: [{ role: "cell", rawType: "Cell", frame: frame(0, 200, 400, 40) }],
			},
		],
	},
	{ role: "keyboard", rawType: "Keyboard", frame: frame(0, 600, 400, 200) },
];

describe("normalizeElements", () => {
	test("fills path ids, depth, normFrame, traits, enabled and children; flat is preorder", () => {
		const { elements, flat } = normalizeElements(tree, screen);
		expect(flat.map((e) => e.id)).toEqual(["0", "0.0", "0.1", "0.1.0", "1"]);
		expect(flat.map((e) => e.depth)).toEqual([0, 1, 1, 2, 0]);
		expect(elements).toHaveLength(2);
		const button = flat[1];
		expect(button?.normFrame).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.1 });
		expect(button?.traits).toEqual([]);
		expect(button?.enabled).toBe(true);
		expect(button?.children).toEqual([]);
		expect(elements[0]?.children[1]?.children[0]).toBe(flat[3]);
	});

	test("keeps what the helper sent", () => {
		const { flat } = normalizeElements(
			[
				{
					id: "ax-7",
					role: "switch",
					rawType: "Switch",
					frame: frame(0, 0, 10, 10),
					normFrame: frame(0, 0, 1, 1),
					depth: 3,
					traits: ["selected"],
					enabled: false,
					value: "1",
				},
			],
			screen
		);
		expect(flat[0]).toMatchObject({ id: "ax-7", depth: 3, traits: ["selected"], enabled: false, value: "1" });
		expect(flat[0]?.normFrame).toEqual(frame(0, 0, 1, 1));
	});

	test("a zero-size screen does not divide by zero", () => {
		const { flat } = normalizeElements(tree, { width: 0, height: 0, scale: 1 });
		expect(flat[0]?.normFrame).toEqual(frame(0, 0, 0, 0));
	});
});

describe("nulls from the helper", () => {
	test("null optional fields are dropped, enabled follows the not-enabled trait", () => {
		const { flat } = normalizeElements(
			[
				{
					role: "textfield",
					rawType: "TextField",
					frame: frame(0, 0, 100, 40),
					label: "Email",
					placeholder: null,
					value: "Email",
					identifier: null,
					enabled: null,
					traits: ["not-enabled"],
					focused: null,
					tapPoint: null,
					pid: null,
					children: null,
				},
				{ role: "button", rawType: "Button", frame: frame(0, 40, 100, 40), enabled: null, traits: null },
			],
			screen
		);
		expect(flat[0]).toMatchObject({ label: "Email", value: "Email", enabled: false, children: [] });
		expect(flat[0] && "placeholder" in flat[0]).toBe(false);
		expect(flat[0] && "identifier" in flat[0]).toBe(false);
		expect(flat[0] && "focused" in flat[0]).toBe(false);
		expect(flat[1]).toMatchObject({ enabled: true, traits: [] });
	});

	test("a null modal is no modal", () => {
		const snapshot = toSnapshot({ backend: "ax", screen, truncated: false, elements: [], ms: 1, modal: null }, 1);
		expect("modal" in snapshot).toBe(false);
	});
});

test("normalizeElement", () => {
	const element = normalizeElement({ role: "button", rawType: "Button", frame: frame(0, 0, 40, 80) }, screen);
	expect(element).toMatchObject({ id: "0", depth: 0, children: [] });
});

test("toSnapshot", () => {
	const snapshot = toSnapshot(
		{ backend: "ax", screen, truncated: true, elements: tree, ms: 12, modal: { description: "alert" } },
		1234
	);
	expect(snapshot).toMatchObject({
		platform: "ios",
		backend: "ax",
		takenAt: 1234,
		truncated: true,
		modal: { description: "alert" },
	});
	expect(snapshot.flat).toHaveLength(5);
});

describe("focus", () => {
	test("the text field UIKit is editing is focused even from a helper that left `focused` false", () => {
		const { flat } = normalizeElements(
			[
				{
					role: "textfield",
					rawType: "TextField",
					frame: frame(0, 0, 100, 40),
					traits: ["is-editing"],
					focused: false,
				},
				{ role: "textfield", rawType: "TextField", frame: frame(0, 40, 100, 40), traits: [], focused: false },
				{ role: "securefield", rawType: "SecureTextField", frame: frame(0, 80, 100, 40), traits: ["is-editing"] },
			],
			screen
		);
		expect(flat.map((element) => element.focused)).toEqual([true, false, true]);
	});
});
