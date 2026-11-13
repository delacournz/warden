import { describe, expect, test } from "bun:test";
import type { Element, Role, Snapshot } from "./driver.types";
import { keyboardFrame, keyboardVisible } from "./keyboard-state";

function el(role: Role, frame: { x: number; y: number; width: number; height: number }, hidden = false): Element {
	return {
		id: "0",
		role,
		rawType: role,
		frame,
		normFrame: frame,
		traits: [],
		enabled: true,
		...(hidden ? { hidden: true } : {}),
		depth: 0,
		children: [],
	};
}

function snap(...flat: Element[]): Snapshot {
	return {
		platform: "ios",
		backend: "ax",
		takenAt: 0,
		screen: { width: 400, height: 800, scale: 2 },
		elements: flat,
		flat,
		truncated: false,
	};
}

describe("keyboardVisible", () => {
	test("a keyboard element with a frame is visible; none, empty or hidden is not", () => {
		const frame = { x: 0, y: 500, width: 400, height: 300 };
		expect(keyboardVisible(snap(el("textfield", frame), el("keyboard", frame)))).toBe(true);
		expect(keyboardVisible(snap(el("textfield", frame)))).toBe(false);
		expect(keyboardVisible(snap(el("keyboard", { x: 0, y: 0, width: 0, height: 0 })))).toBe(false);
		expect(keyboardVisible(snap(el("keyboard", frame, true)))).toBe(false);
	});

	test("a keyboard slid off the bottom of the screen is not visible", () => {
		expect(keyboardVisible(snap(el("keyboard", { x: 0, y: 874, width: 400, height: 300 })))).toBe(false);
		expect(keyboardVisible(snap(el("keyboard", { x: 0, y: 799, width: 400, height: 300 })))).toBe(true);
	});

	test("the frame is the largest keyboard element's", () => {
		const big = { x: 0, y: 500, width: 400, height: 300 };
		expect(keyboardFrame(snap(el("keyboard", { x: 0, y: 500, width: 10, height: 10 }), el("keyboard", big)))).toEqual(
			big
		);
		expect(keyboardFrame(snap())).toBeUndefined();
	});
});
