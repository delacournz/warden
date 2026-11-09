import { describe, expect, test } from "bun:test";
import { type ElementSpec, el, snapshotOf } from "../driver/driver.testing";
import { indexSnapshot, type NodeEntry } from "./nodes";
import { clearTapPoint, describeCover, revealPath } from "./occlusion";

const row = (y: number) =>
	el("button", { id: "row", label: "Biometrics", frame: { x: 20, y, width: 360, height: 70 } });
const footer = el("button", { id: "sign-out", label: "Sign out", frame: { x: 0, y: 760, width: 400, height: 80 } });

function target(
	specs: readonly ElementSpec[],
	id = "row"
): { entry: NodeEntry; index: ReturnType<typeof indexSnapshot> } {
	const index = indexSnapshot(snapshotOf(specs));
	const entry = index.entries.find((e) => e.element.identifier === id);
	if (entry === undefined) throw new Error(`no ${id}`);
	return { entry, index };
}

describe("clearTapPoint", () => {
	test("a target nothing covers keeps its own tap point", () => {
		const { entry, index } = target([row(300), footer]);
		expect(clearTapPoint(entry, index)).toEqual({ kind: "clear", point: { x: 200, y: 335 } });
	});

	test("a target half under a later sticky footer is tapped in its uncovered band", () => {
		const { entry, index } = target([row(740), footer]);
		expect(clearTapPoint(entry, index)).toEqual({ kind: "clear", point: { x: 200, y: 750 } });
	});

	test("a target wholly under a later control is covered, and names it", () => {
		const { entry, index } = target([row(765), footer]);
		const result = clearTapPoint(entry, index);
		expect(result.kind).toBe("covered");
		if (result.kind === "covered" && result.by === "control")
			expect(describeCover(result.cover)).toBe('button "Sign out" (id=sign-out)');
	});

	test("an earlier control is under the target, not over it", () => {
		const { entry, index } = target([footer, row(765)]);
		expect(clearTapPoint(entry, index).kind).toBe("clear");
	});

	test("the target's own descendants never cover it", () => {
		const parent = el("button", {
			id: "row",
			label: "Row",
			frame: { x: 20, y: 300, width: 360, height: 70 },
			children: [el("checkbox", { id: "check", frame: { x: 30, y: 310, width: 50, height: 50 } })],
		});
		const { entry, index } = target([parent]);
		expect(clearTapPoint(entry, index)).toEqual({ kind: "clear", point: { x: 200, y: 335 } });
	});

	test("a later container or text over it is no cover: only controls take the touch", () => {
		const overlay = el("other", { frame: { x: 0, y: 0, width: 400, height: 900 } });
		const text = el("text", { label: "caption", frame: { x: 0, y: 300, width: 400, height: 100 } });
		const { entry, index } = target([row(300), overlay, text]);
		expect(clearTapPoint(entry, index).kind).toBe("clear");
	});

	test("keys of the on-screen keyboard are left to the keyboard handling", () => {
		const keyboard = el("keyboard", {
			frame: { x: 0, y: 500, width: 400, height: 340 },
			children: [el("button", { label: "q", frame: { x: 0, y: 500, width: 400, height: 340 } })],
		});
		const { entry, index } = target([row(600), keyboard]);
		expect(clearTapPoint(entry, index).kind).toBe("clear");
	});

	test("a hidden later control covers nothing", () => {
		const hidden = el("button", { label: "ghost", hidden: true, frame: { x: 0, y: 0, width: 400, height: 900 } });
		const { entry, index } = target([row(300), hidden]);
		expect(clearTapPoint(entry, index).kind).toBe("clear");
	});

	test("a footer's padded bar blocks too: a strip under its padding is not tapped", () => {
		const bar = el("other", {
			frame: { x: 0, y: 740, width: 400, height: 100 },
			children: [el("button", { id: "sign-out", label: "Sign out", frame: { x: 20, y: 756, width: 360, height: 52 } })],
		});
		const { entry, index } = target([row(745), bar]);
		const result = clearTapPoint(entry, index);
		expect(result.kind).toBe("covered");
		if (result.kind === "covered") expect(result.region).toEqual({ x: 0, y: 740, width: 400, height: 100 });
	});

	test("a full-screen overlay holding a floating button is not the cover, the button is", () => {
		const overlay = el("other", {
			frame: { x: 0, y: 0, width: 400, height: 900 },
			children: [el("button", { id: "fab", label: "Add", frame: { x: 170, y: 300, width: 60, height: 60 } })],
		});
		const { entry, index } = target([row(300), overlay]);
		expect(clearTapPoint(entry, index)).toEqual({ kind: "clear", point: { x: 200, y: 365 } });
	});

	test("a cover over the left part moves the point right, on the target's centre line", () => {
		const fab = el("button", { id: "fab", label: "Add", frame: { x: 0, y: 280, width: 250, height: 110 } });
		const { entry, index } = target([row(300), fab]);
		expect(clearTapPoint(entry, index)).toEqual({ kind: "clear", point: { x: 315, y: 335 } });
	});
});

describe("revealPath", () => {
	const inList = (rowY: number, cover: ElementSpec) =>
		target([
			el("scrollview", {
				frame: { x: 0, y: 0, width: 390, height: 844 },
				children: [el("button", { id: "row", label: "Row", frame: { x: 20, y: rowY, width: 350, height: 70 } })],
			}),
			cover,
		]);

	test("under a footer the content is dragged up, starting above the footer", () => {
		const { entry, index } = inList(770, footer);
		const result = clearTapPoint(entry, index);
		if (result.kind !== "covered") throw new Error("expected covered");
		const path = revealPath(entry, result, index);
		expect(path?.from.y).toBeLessThan(760);
		expect((path?.from.y ?? 0) - (path?.to.y ?? 0)).toBeGreaterThan(0);
	});

	test("under a header the content is dragged down, starting below the header", () => {
		const header = el("button", { id: "back", label: "Back", frame: { x: 0, y: 0, width: 390, height: 100 } });
		const { entry, index } = inList(10, header);
		const result = clearTapPoint(entry, index);
		if (result.kind !== "covered") throw new Error("expected covered");
		const path = revealPath(entry, result, index);
		expect(path?.from.y).toBeGreaterThan(100);
		expect((path?.to.y ?? 0) - (path?.from.y ?? 0)).toBeGreaterThan(0);
	});

	test("outside a scroll container there is no path", () => {
		const { entry, index } = target([
			el("button", { id: "row", frame: { x: 20, y: 770, width: 350, height: 70 } }),
			footer,
		]);
		const result = clearTapPoint(entry, index);
		if (result.kind !== "covered") throw new Error("expected covered");
		expect(revealPath(entry, result, index)).toBeUndefined();
	});
});

describe("a React Native list on iOS: a group whose content child runs past it", () => {
	const list = (switchY: number) =>
		target(
			[
				el("other", {
					frame: { x: 0, y: 118, width: 402, height: 673 },
					children: [
						el("other", {
							frame: { x: 0, y: 55, width: 402, height: 930 },
							children: [
								el("switch", {
									id: "row",
									label: "Notifications",
									frame: { x: 313, y: switchY, width: 52, height: 44 },
								}),
							],
						}),
					],
				}),
			],
			"row"
		);

	test("a switch scrolled up under the header is blocked by the list's top edge", () => {
		const { entry, index } = list(64);
		const result = clearTapPoint(entry, index);
		expect(result.kind).toBe("covered");
		if (result.kind !== "covered") return;
		expect(result.by).toBe("edge");
		const path = revealPath(entry, result, index);
		expect(path?.from.y).toBeGreaterThan(118);
		expect((path?.to.y ?? 0) - (path?.from.y ?? 0)).toBeGreaterThan(0);
	});

	test("a switch half past the top edge is tapped on its part inside the list", () => {
		const { entry, index } = list(100);
		expect(clearTapPoint(entry, index)).toEqual({ kind: "clear", point: { x: 339, y: 131 } });
	});
});
