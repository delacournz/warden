import { describe, expect, test } from "bun:test";
import type { Element, ElementContent, Root } from "hast";
import { rehypeRowAnchors, rowSlug } from "./row-anchors";

describe("rowSlug", () => {
	test.each([
		["gesture pinch [target] <scale>", "gesture-pinch"],
		["snapshot [-i|--interactive] [--all]", "snapshot"],
		["snapshot --settle [ms]", "snapshot-settle"],
		["screen video start [path]", "screen-video-start"],
		["open <bundleId|url> [--relaunch]", "open"],
		["screen.gesture.pinch({ scale, center? })", "screen-gesture-pinch"],
		["id=", "id"],
		["editable=true|false", "editable"],
		["--udid <udid>", "udid"],
		["gesture path --path 'x,y x,y …' [--path …]", "gesture-path"],
		["logs --limit <n>", "logs"],
		["WARDEN_HOME", "warden-home"],
		["<selector>", undefined],
	])("%s → %s", (code, slug) => {
		expect(rowSlug(code)).toBe(slug);
	});
});

const text = (value: string) => ({ type: "text" as const, value });
const el = (tagName: string, children: ElementContent[], properties: Element["properties"] = {}): Element => ({
	type: "element",
	tagName,
	properties,
	children,
});
const row = (first: ElementContent[]) => el("tr", [el("td", first), el("td", [text("what it does")])]);

function table(rows: Element[]): Root {
	return {
		type: "root",
		children: [
			el("h2", [text("Acting")], { id: "acting" }),
			el("table", [el("thead", [el("tr", [el("th", [text("Command")])])]), el("tbody", rows)]),
		],
	};
}

function run(tree: Root): Element[] {
	rehypeRowAnchors()(tree);
	const body = (tree.children[1] as Element).children[1] as Element;
	return body.children as Element[];
}

describe("rehypeRowAnchors", () => {
	test("a row led by code gets an id, and its code links to it", () => {
		const [tr] = run(table([row([el("code", [text("gesture pinch [target] <scale>")])])]));
		expect(tr.properties.id).toBe("gesture-pinch");
		const link = (tr.children[0] as Element).children[0] as Element;
		expect(link.tagName).toBe("a");
		expect(link.properties).toMatchObject({ href: "#gesture-pinch", className: ["row-anchor"] });
		expect((link.children[0] as Element).tagName).toBe("code");
	});

	test("a row led by prose is left alone", () => {
		const [tr] = run(table([row([text("Plain words "), el("code", [text("open")])])]));
		expect(tr.properties.id).toBeUndefined();
	});

	test("a repeated name takes its section's heading, then a number", () => {
		const rows = run(
			table([
				row([el("code", [text("snapshot")])]),
				row([el("code", [text("snapshot [-i]")])]),
				row([el("code", [text("acting")])]),
			])
		);
		expect(rows.map((tr) => tr.properties.id)).toEqual(["snapshot", "acting-snapshot", "acting-2"]);
	});

	test("the header row is not a target", () => {
		const tree = table([]);
		const head = ((tree.children[1] as Element).children[0] as Element).children[0] as Element;
		(head.children[0] as Element).children = [el("code", [text("Command")])];
		rehypeRowAnchors()(tree);
		expect(head.properties.id).toBeUndefined();
	});
});
