import { describe, expect, test } from "bun:test";
import { dedupeAlertButtons } from "./alert-buttons";
import type { Element } from "./driver/driver.types";

function button(label: string, x: number): Element {
	return {
		id: `${label}@${x}`,
		role: "button",
		rawType: "Button",
		label,
		frame: { x, y: 0, width: 100, height: 44 },
		depth: 0,
		normFrame: { x: 0, y: 0, width: 0, height: 0 },
		traits: [],
		enabled: true,
		children: [],
	};
}

describe("dedupeAlertButtons", () => {
	test("a button read twice at the same frame is listed once, in first-seen order", () => {
		const read = [
			button("Try Face ID Again", 0),
			button("Cancel", 100),
			button("Try Face ID Again", 0),
			button("Cancel", 100),
		];
		expect(dedupeAlertButtons(read).map((b) => b.label)).toEqual(["Try Face ID Again", "Cancel"]);
	});

	test("two buttons with one label at different frames are both kept", () => {
		const read = [button("OK", 0), button("OK", 100)];
		expect(dedupeAlertButtons(read)).toHaveLength(2);
	});

	test("an empty list stays empty", () => {
		expect(dedupeAlertButtons([])).toEqual([]);
	});
});
