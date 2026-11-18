import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Element } from "../driver.types";
import { NOT_SHOWING_HINT_TRAIT, SHOWING_HINT_TRAIT } from "../hint-state";
import { readSnapshotData, type UiadNode } from "./uiad-protocol";
import { parseUiadNodes, parseUiautomatorXml } from "./uiautomator";

const SESSION = readFileSync(join(import.meta.dir, "fixtures/uiad-session.ndjson"), "utf8")
	.trim()
	.split("\n");
const SCREEN = { width: 1080, height: 2424 };

function snapshots(): UiadNode[][] {
	const found: UiadNode[][] = [];
	for (const line of SESSION) {
		const json: unknown = JSON.parse(line);
		if (typeof json !== "object" || json === null || !("data" in json)) continue;
		const data = readSnapshotData(json.data);
		if (typeof data !== "string") found.push(data.elements);
	}
	return found;
}

const esc = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What `uiautomator dump` would have written for the same nodes (every attribute the parser reads, flags spelled out). */
function toDumpXml(nodes: readonly UiadNode[]): string {
	const flag = (on: boolean | undefined): string => (on ? "true" : "false");
	const render = (node: UiadNode): string => {
		const [l, t, r, b] = node.bounds;
		const attrs = [
			`text="${esc(node.text ?? "")}"`,
			`resource-id="${esc(node.id ?? "")}"`,
			`class="${esc(node.class ?? "")}"`,
			`content-desc="${esc(node.desc ?? "")}"`,
			`checkable="${flag(node.checkable)}"`,
			`checked="${flag(node.checked)}"`,
			`clickable="${flag(node.clickable)}"`,
			`enabled="${node.disabled ? "false" : "true"}"`,
			`focused="${flag(node.focused)}"`,
			`scrollable="${flag(node.scrollable)}"`,
			`long-clickable="${flag(node.longClickable)}"`,
			`focusable="${flag(node.focusable)}"`,
			`password="${flag(node.password)}"`,
			`selected="${flag(node.selected)}"`,
			`bounds="[${l},${t}][${r},${b}]"`,
			`hint="${esc(node.hint ?? "")}"`,
		].join(" ");
		const inner = (node.children ?? []).map(render).join("");
		return inner ? `<node ${attrs}>${inner}</node>` : `<node ${attrs} />`;
	};
	return `<?xml version='1.0' ?><hierarchy rotation="0">${nodes.map(render).join("")}</hierarchy>`;
}

/** The nodes without `showingHint`, which only the server knows (the dump has no such attribute). */
function withoutHintState(nodes: readonly UiadNode[]): UiadNode[] {
	return nodes.map(({ showingHint: _showingHint, children, ...rest }) => ({
		...rest,
		...(children ? { children: withoutHintState(children) } : {}),
	}));
}

/** The elements with `a11y` cut down to `focusable`, the one fact both sources have. */
function withoutHelperA11y(elements: readonly Element[]): Element[] {
	return elements.map(({ a11y, children: _children, ...rest }) => ({
		...rest,
		children: [],
		...(a11y?.focusable === undefined ? {} : { a11y: { focusable: a11y.focusable } }),
	}));
}

describe("parseUiadNodes", () => {
	test("gives the very same elements as parsing the dump of the same nodes, but for the hint state", () => {
		const all = snapshots().map(withoutHintState);
		expect(all.length).toBeGreaterThanOrEqual(3);
		for (const nodes of all) {
			const viaXml = parseUiautomatorXml(toDumpXml(nodes), SCREEN);
			const viaNodes = parseUiadNodes(nodes, SCREEN);
			expect(viaNodes.flat.length).toBeGreaterThan(5);
			expect(withoutHelperA11y(viaNodes.flat)).toEqual(withoutHelperA11y(viaXml.flat));
		}
	});

	test("keeps focusable on both paths and the helper-only a11y facts on the helper path alone", () => {
		const nodes: UiadNode[] = [
			{
				bounds: [0, 0, 100, 100],
				class: "android.view.ViewGroup",
				focusable: true,
				a11yFocused: true,
				notImportant: true,
				live: 2,
				actions: ["Archive", "Delete"],
			},
			{ bounds: [0, 100, 100, 200], class: "android.widget.TextView", live: 1 },
		];
		const [group, text] = parseUiadNodes(nodes, SCREEN).flat;
		expect(group?.a11y).toEqual({
			focusable: true,
			important: false,
			a11yFocused: true,
			liveRegion: "assertive",
			actions: ["Archive", "Delete"],
		});
		expect(text?.a11y).toEqual({ focusable: false, important: true, liveRegion: "polite" });
		const dumped = parseUiautomatorXml(toDumpXml(nodes), SCREEN).flat;
		expect(dumped[0]?.a11y).toEqual({ focusable: true });
		expect(dumped[1]?.a11y).toEqual({ focusable: false });
	});

	test("a dump without a focusable attribute leaves a11y undefined", () => {
		const xml = `<hierarchy><node class="android.widget.TextView" bounds="[0,0][10,10]" /></hierarchy>`;
		expect(parseUiautomatorXml(xml, SCREEN).flat[0]?.a11y).toBeUndefined();
	});

	test("maps testIDs and platform ids like the dump: the package prefix is dropped, a bare id stays", () => {
		const [welcome] = snapshots();
		const tree = parseUiadNodes(welcome ?? [], SCREEN);
		const identifiers = new Set(tree.flat.map((e) => e.identifier));
		expect(identifiers.has("welcome-screen")).toBe(true);
		expect(identifiers.has("content")).toBe(true);
	});

	test("a disabled node is not enabled and not hittable; checkable nodes report checked", () => {
		const tree = parseUiadNodes(
			[
				{ bounds: [0, 0, 100, 100], class: "android.widget.Button", clickable: true, disabled: true },
				{
					bounds: [0, 100, 100, 200],
					class: "android.widget.CheckBox",
					clickable: true,
					checkable: true,
					checked: true,
				},
			],
			SCREEN
		);
		const [button, box] = tree.flat;
		expect(button).toMatchObject({ role: "button", enabled: false, hittable: false });
		expect(box).toMatchObject({ role: "checkbox", checked: true, hittable: true });
	});
});

describe("parseUiadNodes hint state", () => {
	const field = (text: string, showingHint: boolean | undefined): UiadNode => ({
		bounds: [0, 0, 100, 100],
		class: "android.widget.EditText",
		id: "sign-in-email",
		text,
		hint: "ada@example.com",
		editable: true,
		...(showingHint === undefined ? {} : { showingHint }),
	});

	test("a field the server says shows its hint is empty: no value or text, the hint only as placeholder", () => {
		const [empty] = parseUiadNodes([field("ada@example.com", true)], SCREEN).flat;
		expect(empty?.value).toBe("");
		expect(empty?.text).toBeUndefined();
		expect(empty?.placeholder).toBe("ada@example.com");
		expect(empty?.traits).toContain(SHOWING_HINT_TRAIT);
	});

	test("a field the server says holds text keeps it, even when it is the hint's text", () => {
		const [typed] = parseUiadNodes([field("ada@example.com", false)], SCREEN).flat;
		expect(typed?.value).toBe("ada@example.com");
		expect(typed?.text).toBe("ada@example.com");
		expect(typed?.placeholder).toBe("ada@example.com");
		expect(typed?.traits).toContain(NOT_SHOWING_HINT_TRAIT);
		expect(typed?.traits).not.toContain(SHOWING_HINT_TRAIT);
	});

	test("an unknown hint state (old server, API < 26) adds no trait and keeps the text as reported", () => {
		const [unknown] = parseUiadNodes([field("ada@example.com", undefined)], SCREEN).flat;
		expect(unknown?.value).toBe("ada@example.com");
		expect(unknown?.traits).not.toContain(SHOWING_HINT_TRAIT);
		expect(unknown?.traits).not.toContain(NOT_SHOWING_HINT_TRAIT);
	});

	test("the recorded session's empty sign-in email field says it shows its hint", () => {
		const fields = snapshots()
			.flatMap((nodes) => parseUiadNodes(nodes, SCREEN).flat)
			.filter((e) => e.identifier === "sign-in-email");
		const empty = fields.find((e) => e.traits.includes(SHOWING_HINT_TRAIT));
		expect(empty?.placeholder).toBe("ada@example.com");
		expect(empty?.text).toBeUndefined();
	});
});
