import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("parseUiadNodes", () => {
	test("gives the very same elements as parsing the dump of the same nodes", () => {
		const all = snapshots();
		expect(all.length).toBeGreaterThanOrEqual(3);
		for (const nodes of all) {
			const viaXml = parseUiautomatorXml(toDumpXml(nodes), SCREEN);
			const viaNodes = parseUiadNodes(nodes, SCREEN);
			expect(viaNodes.flat.length).toBeGreaterThan(5);
			expect(viaNodes).toEqual(viaXml);
		}
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
