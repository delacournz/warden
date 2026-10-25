import { describe, expect, test } from "bun:test";
import { el, snapshotOf } from "../driver/driver.testing";
import { coordsTarget, targetFromElement } from "./target";

describe("targetFromElement", () => {
	const snapshot = snapshotOf([
		el("button", { id: "sign-in-submit", label: "Sign in", frame: { x: 24, y: 300, width: 342, height: 48 } }),
		el("button", { label: "Sign in with Apple", frame: { x: 24, y: 360, width: 342, height: 48 } }),
		el("button", { id: "row", label: "Row" }),
		el("button", { id: "row", label: "Row" }),
		el("button", { text: "Save" }),
		el("other"),
		el("other"),
	]);
	const at = (id: string) => {
		const element = snapshot.flat.find((candidate) => candidate.id === id);
		if (!element) throw new Error(`no element ${id}`);
		return element;
	};

	test("builds the chain id → role+label → path and a landmark", () => {
		const target = targetFromElement(at("0"), snapshot);
		expect(target).toEqual({
			kind: "selector",
			selector: "id=sign-in-submit",
			chain: [
				{ by: "id", selector: "id=sign-in-submit" },
				// "Sign in" is also a substring of "Sign in with Apple": pinned with nth
				{ by: "role-label", selector: 'label="Sign in" role=button nth=0' },
				{ by: "path", path: "0", role: "button" },
			],
			landmark: { role: "button", frame: { x: 24, y: 300, width: 342, height: 48 }, label: "Sign in" },
		});
	});

	test("pins repeated ids with nth in document order", () => {
		const second = targetFromElement(at("3"), snapshot);
		expect(second.kind === "selector" && second.selector).toBe("id=row nth=1");
	});

	test("records how many nodes the primary selector matched, only when more than one", () => {
		const unique = targetFromElement(at("0"), snapshot);
		expect(unique.kind === "selector" && unique.matches).toBeUndefined();
		const repeated = targetFromElement(at("3"), snapshot);
		expect(repeated.kind === "selector" && repeated.matches).toBe(2);
		const bare = targetFromElement(at("6"), snapshot);
		expect(bare.kind === "selector" && bare.matches).toBe(2);
	});

	test("an Android-style element with only text goes role+text", () => {
		const target = targetFromElement(at("4"), snapshot);
		if (target.kind !== "selector") throw new Error("expected a selector target");
		expect(target.chain.map((entry) => entry.by)).toEqual(["role-text", "path"]);
		expect(target.selector).toBe("text=Save role=button");
	});

	test("an element with nothing to say falls back to role + nth and the path", () => {
		const target = targetFromElement(at("6"), snapshot);
		if (target.kind !== "selector") throw new Error("expected a selector target");
		expect(target.selector).toBe("role=other nth=1");
		expect(target.chain).toEqual([{ by: "path", path: "6", role: "other" }]);
	});

	test("lists role+text after role+label only when text differs from the label", () => {
		const both = snapshotOf([el("button", { id: "go", label: "Go", text: "GO NOW" })]);
		const target = targetFromElement(both.flat[0] ?? at("0"), both);
		if (target.kind !== "selector") throw new Error("expected a selector target");
		expect(target.chain.map((entry) => entry.by)).toEqual(["id", "role-label", "role-text", "path"]);
	});

	test("never stores an @ref", () => {
		const target = targetFromElement(at("0"), snapshot);
		expect(JSON.stringify(target)).not.toMatch(/@e\d/);
	});

	test("an element that is not in the snapshot becomes a coordinate target with a warning", () => {
		const stranger = { ...at("0"), id: "9.9" };
		const target = targetFromElement(stranger, snapshot);
		expect(target.kind).toBe("coords");
		if (target.kind === "coords") {
			expect(target.x).toBe(195);
			expect(target.y).toBe(324);
			expect(target.warning).toContain("not in the snapshot");
		}
	});

	test("coordsTarget carries the default warning", () => {
		expect(coordsTarget({ x: 1, y: 2 }).warning).toContain("coordinates");
	});
});
