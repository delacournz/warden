import { describe, expect, test } from "bun:test";
import type { ReactTree } from "@delacour/warden-e2e/devtools/devtools.types";
import { filterTree } from "./tree-filter";

const tree: ReactTree = {
	screen: "home",
	truncated: false,
	components: [
		{ id: 0, name: "App", parent: null },
		{ id: 1, name: "View", testID: "list", parent: 0 },
		{ id: 2, name: "Row", parent: 1 },
		{ id: 3, name: "Text", parent: 2 },
		{ id: 4, name: "View", testID: "footer", parent: 0 },
	],
};

const ids = (t: ReactTree) => t.components.map((c) => c.id);

describe("filterTree", () => {
	test("no filter keeps the tree", () => {
		expect(filterTree(tree, {})).toBe(tree);
	});

	test("depth cuts below the top-level roots", () => {
		expect(ids(filterTree(tree, { depth: 1 }))).toEqual([0, 1, 4]);
		expect(ids(filterTree(tree, { depth: 0 }))).toEqual([0]);
	});

	test("testID keeps that subtree only", () => {
		expect(ids(filterTree(tree, { testID: "list" }))).toEqual([1, 2, 3]);
	});

	test("testID and depth count from the matched component", () => {
		expect(ids(filterTree(tree, { testID: "list", depth: 1 }))).toEqual([1, 2]);
	});

	test("an unknown testID leaves nothing and keeps the screen", () => {
		const out = filterTree(tree, { testID: "nope" });
		expect(out.components).toEqual([]);
		expect(out.screen).toBe("home");
	});
});
