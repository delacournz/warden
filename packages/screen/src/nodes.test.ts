import { describe, expect, test } from "bun:test";
import { el, snap } from "./element.testing";
import { allFixtureSnapshots } from "./fixtures.testing";
import { descendantsOf, indexSnapshot, isWithin, type NodeEntry, type NodeIndex } from "./nodes";
import { normalizeText } from "./text";

describe("indexSnapshot structure", () => {
	const leafA = el("button", { label: "A", identifier: "a" });
	const leafB = el("text", { label: "B" });
	const group = el("other", { identifier: "group" }, [leafA, leafB]);
	const root = el("window", {}, [group, el("button", { label: "C" })]);
	const index = indexSnapshot(snap([root]));

	test("entries are in document order with depth, parent and children", () => {
		expect(index.entries.map((entry) => entry.element.label ?? entry.element.identifier ?? entry.element.role)).toEqual(
			["window", "group", "A", "B", "C"]
		);
		expect(index.entries.map((entry) => entry.depth)).toEqual([0, 1, 2, 2, 1]);
		expect(index.entries.map((entry) => entry.position)).toEqual([0, 1, 2, 3, 4]);
		const [windowEntry, groupEntry, a] = index.entries;
		expect(windowEntry?.parent).toBeUndefined();
		expect(groupEntry?.parent).toBe(windowEntry);
		expect(a?.parent).toBe(groupEntry);
		expect(groupEntry?.children.map((child) => child.element.label)).toEqual(["A", "B"]);
	});

	test("byId finds entries", () => {
		expect(index.byId.get("0.0.0")?.element.label).toBe("A");
	});

	test("isWithin and descendantsOf", () => {
		const [windowEntry, groupEntry, a, , c] = index.entries;
		expect(a && groupEntry && isWithin(a, groupEntry)).toBe(true);
		expect(a && windowEntry && isWithin(a, windowEntry)).toBe(true);
		expect(c && groupEntry && isWithin(c, groupEntry)).toBe(false);
		expect(groupEntry && isWithin(groupEntry, groupEntry)).toBe(false);
		expect(descendantsOf(index.entries, groupEntry ? [groupEntry] : []).length).toBe(2);
	});

	test("an empty snapshot indexes to nothing", () => {
		expect(indexSnapshot(snap([])).entries).toEqual([]);
	});
});

describe("names, values, secure", () => {
	test("name is label, else text; value is trimmed element value", () => {
		const index = indexSnapshot(
			snap([el("text", { label: "L", text: "T" }), el("text", { text: "T" }), el("textfield", { value: "v" })])
		);
		expect(index.entries.map((entry) => entry.name)).toEqual(["L", "T", undefined]);
		expect(index.entries[2]?.value).toBe("v");
	});

	test("empty strings count as absent", () => {
		const entry = indexSnapshot(snap([el("textfield", { label: "", value: "", identifier: "" })])).entries[0];
		expect(entry?.name).toBeUndefined();
		expect(entry?.value).toBeUndefined();
	});

	test("secure fields never expose a value", () => {
		const entry = indexSnapshot(snap([el("securefield", { value: "••••", label: "Password" })])).entries[0];
		expect(entry?.secure).toBe(true);
		expect(entry?.value).toBeUndefined();
		expect(entry?.name).toBe("Password");
	});

	test("Android password trait is secure", () => {
		const entry = indexSnapshot(
			snap([el("textfield", { rawType: "android.widget.EditText", traits: ["password"], value: "x" })], {
				platform: "android",
			})
		).entries[0];
		expect(entry?.secure).toBe(true);
	});
});

describe("checked", () => {
	const checkedOf = (element: ReturnType<typeof el>) => indexSnapshot(snap([element])).entries[0]?.states.checked;

	test("switch values 1/0 and on/off", () => {
		expect(checkedOf(el("switch", { value: "1" }))).toBe(true);
		expect(checkedOf(el("switch", { value: "0" }))).toBe(false);
		expect(checkedOf(el("switch", { value: "On" }))).toBe(true);
		expect(checkedOf(el("switch", { value: "off" }))).toBe(false);
	});

	test("a value on a non-checkable role is not a checked state", () => {
		expect(checkedOf(el("textfield", { value: "1" }))).toBeUndefined();
		expect(checkedOf(el("slider", { value: "0" }))).toBeUndefined();
	});

	test("driver `checked` wins", () => {
		expect(checkedOf(el("checkbox", { checked: true }))).toBe(true);
		expect(checkedOf(el("switch", { checked: false, value: "1" }))).toBe(false);
	});

	test("React Native iOS value prefixes", () => {
		const unchecked = indexSnapshot(snap([el("other", { value: "checkbox, unchecked", label: "Agree" })])).entries[0];
		expect(unchecked?.role).toBe("checkbox");
		expect(unchecked?.states.checked).toBe(false);
		expect(unchecked?.value).toBeUndefined();
		const checked = indexSnapshot(snap([el("other", { value: "radio button, checked, Pro" })])).entries[0];
		expect(checked?.role).toBe("radio");
		expect(checked?.states.checked).toBe(true);
		expect(checked?.value).toBe("Pro");
	});

	test("Android checkable / checked traits", () => {
		const on = indexSnapshot(
			snap([el("other", { rawType: "android.widget.CheckBox", traits: ["clickable", "checkable", "checked"] })], {
				platform: "android",
			})
		).entries[0];
		expect(on?.states.checked).toBe(true);
		const off = indexSnapshot(
			snap([el("other", { rawType: "android.widget.CheckBox", traits: ["clickable", "checkable"] })], {
				platform: "android",
			})
		).entries[0];
		expect(off?.states.checked).toBe(false);
		const plain = indexSnapshot(
			snap([el("other", { rawType: "android.widget.TextView", traits: ["checked"] })], { platform: "android" })
		).entries[0];
		expect(plain?.states.checked).toBeUndefined();
	});
});

describe("states and visibility", () => {
	test("disabled, selected, focused, expanded", () => {
		const entry = indexSnapshot(snap([el("button", { enabled: false, selected: true, focused: true })])).entries[0];
		expect(entry?.states).toMatchObject({ disabled: true, selected: true, focused: true, hidden: false });
	});

	test("hidden flag", () => {
		const entry = indexSnapshot(snap([el("button", { hidden: true })])).entries[0];
		expect(entry?.states.hidden).toBe(true);
		expect(entry?.visible).toBe(false);
	});

	test("hidden is inherited by descendants", () => {
		const index = indexSnapshot(snap([el("other", { hidden: true }, [el("button")]), el("button")]));
		expect(index.entries.map((entry) => entry.states.hidden)).toEqual([true, true, false]);
	});

	test("visible needs a non-empty frame inside the screen", () => {
		const index = indexSnapshot(
			snap([
				el("button", { frame: { x: 10, y: 10, width: 50, height: 20 } }),
				el("button", { frame: { x: 10, y: 10, width: 0, height: 20 } }),
				el("button", { frame: { x: 10, y: 900, width: 50, height: 20 } }),
				el("button", { frame: { x: -100, y: 10, width: 50, height: 20 } }),
				el("button", { frame: { x: 380, y: 10, width: 50, height: 20 } }),
			])
		);
		expect(index.entries.map((entry) => entry.visible)).toEqual([true, false, false, false, true]);
	});

	test("an unknown screen size skips the bounds check", () => {
		const index = indexSnapshot(
			snap([el("button", { frame: { x: 5000, y: 5000, width: 10, height: 10 } })], {
				screen: { width: 0, height: 0, scale: 1 },
			})
		);
		expect(index.entries[0]?.visible).toBe(true);
	});
});

describe("subtreeText", () => {
	test("collects label, text and value of the node and its descendants in order", () => {
		const index = indexSnapshot(
			snap([
				el("other", {}, [
					el("text", { label: "Invoice 42" }),
					el("text", { label: "$10" }),
					el("textfield", { value: "qty" }),
				]),
			])
		);
		expect(index.entries[0]?.subtreeText).toBe("Invoice 42 $10 qty");
		expect(index.entries[1]?.subtreeText).toBe("Invoice 42");
	});

	test("iOS echoes are dropped: a container labelled with its child's text counts once", () => {
		const index = indexSnapshot(
			snap([
				el("other", { label: "Hello" }, [el("text", { label: "Hello" })]),
				el("other", { label: "A B" }, [el("text", { label: "A" }), el("text", { label: "B" })]),
			])
		);
		expect(index.entries[0]?.subtreeText).toBe("Hello");
		expect(index.entries[2]?.subtreeText).toBe("A B");
	});

	test("whitespace is collapsed and secure values are left out", () => {
		const index = indexSnapshot(
			snap([el("other", {}, [el("text", { label: " a \n b " }), el("securefield", { value: "secret" })])])
		);
		expect(index.entries[0]?.subtreeText).toBe("a b");
	});

	test("fragments are exposed for per-fragment matching", () => {
		const index = indexSnapshot(snap([el("other", {}, [el("text", { label: "x" }), el("text", { label: "y" })])]));
		expect(index.entries[0]?.fragments).toEqual(["x", "y"]);
	});
});

/**
 * The subtree text as it was computed while indexing, kept here as the reference the lazy version must equal: a
 * node's own texts (label, text, value, name) minus anything its descendants already say, then the descendants' texts.
 */
function eagerSubtree(index: NodeIndex): { fragments: string[]; subtreeText: string }[] {
	const result: { fragments: string[]; subtreeText: string }[] = [];
	const visit = (entry: NodeEntry): string[] => {
		const below = entry.children.flatMap(visit);
		const belowText = below.join(" ");
		const seen = new Set<string>();
		for (const raw of [entry.element.label, entry.element.text, entry.value]) {
			const text = raw === undefined ? "" : normalizeText(raw);
			if (text !== "") seen.add(text);
		}
		if (entry.name !== undefined && normalizeText(entry.name) !== "") seen.add(normalizeText(entry.name));
		const own = [...seen].filter((text) => text !== belowText && !below.includes(text));
		const fragments = [...own, ...below];
		result[entry.position] = { fragments, subtreeText: fragments.join(" ") };
		return fragments;
	};
	for (const entry of index.entries) if (entry.parent === undefined) visit(entry);
	return result;
}

/** A fixed shuffle (a multiplicative walk over the positions), so the order is odd but the test is repeatable. */
function scrambled<T>(items: readonly T[]): T[] {
	const count = items.length;
	if (count < 3) return [...items];
	let step = 7;
	while (count % step === 0 || step >= count) step += 2;
	return items.map((_, position) => items[(position * step + 1) % count] as T);
}

describe("lazy subtree text", () => {
	test("is not built by indexing: the accessors compute on first read and then keep their answer", () => {
		const index = indexSnapshot(snap([el("other", {}, [el("text", { label: "x" }), el("text", { label: "y" })])]));
		const [root] = index.entries;
		for (const key of ["fragments", "subtreeText"] as const) {
			expect(typeof Object.getOwnPropertyDescriptor(root, key)?.get).toBe("function");
		}
		expect(root?.fragments).toBe(root?.fragments);
		expect(root?.subtreeText).toBe("x y");
	});

	test("reading a child first, then its parent, gives the parent the child's answer", () => {
		const index = indexSnapshot(
			snap([el("other", { label: "Hello" }, [el("text", { label: "Hello" })]), el("text", { label: "tail" })])
		);
		const [parent, child] = index.entries;
		expect(child?.subtreeText).toBe("Hello");
		expect(parent?.subtreeText).toBe("Hello");
		expect(parent?.fragments).toEqual(["Hello"]);
	});

	for (const { name, snapshot } of allFixtureSnapshots()) {
		describe(name, () => {
			const orders: Record<string, (entries: readonly NodeEntry[]) => NodeEntry[]> = {
				"document order": (entries) => [...entries],
				"deepest first": (entries) => [...entries].reverse(),
				"scrambled order": scrambled,
			};
			for (const [label, order] of Object.entries(orders)) {
				test(`equals the eager computation for every node, read in ${label}`, () => {
					const index = indexSnapshot(snapshot);
					const reference = eagerSubtree(indexSnapshot(snapshot));
					expect(index.entries.length).toBe(reference.length);
					expect(reference.some((texts) => texts.subtreeText !== "")).toBe(true);
					for (const entry of order(index.entries)) {
						const want = reference[entry.position];
						expect(entry.subtreeText).toBe(want?.subtreeText as string);
						expect(entry.fragments).toEqual(want?.fragments as string[]);
					}
				});
			}

			test("reading only the root does not change what a node deep inside answers", () => {
				const lazy = indexSnapshot(snapshot);
				const eager = indexSnapshot(snapshot);
				void lazy.entries[0]?.subtreeText;
				const deepest = [...lazy.entries].sort((a, b) => b.depth - a.depth)[0];
				if (deepest === undefined) return;
				expect(deepest.subtreeText).toBe(eager.entries[deepest.position]?.subtreeText as string);
			});
		});
	}
});
