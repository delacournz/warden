import { describe, expect, test } from "bun:test";
import { TREE_SCRIPT, type TreeScriptConfig, treeInstallExpression } from "./tree.script";

/** A hand-built React fiber: only the fields the script reads. */
type Fiber = {
	type: unknown;
	tag: number;
	memoizedProps: unknown;
	child: Fiber | null;
	sibling: Fiber | null;
	return: Fiber | null;
	stateNode: unknown;
};

type Rect = { x: number; y: number; w: number; h: number };

function fiber(
	type: unknown,
	props: unknown,
	children: Fiber[] = [],
	extra: Partial<Pick<Fiber, "tag" | "stateNode">> = {}
): Fiber {
	const node: Fiber = {
		type,
		tag: extra.tag ?? 0,
		memoizedProps: props,
		child: null,
		sibling: null,
		return: null,
		stateNode: extra.stateNode ?? null,
	};
	let previous: Fiber | undefined;
	for (const child of children) {
		child.return = node;
		if (previous) previous.sibling = child;
		else node.child = child;
		previous = child;
	}
	return node;
}

const measurable = (rect: Rect) => ({
	measureInWindow: (cb: (...n: number[]) => void) => cb(rect.x, rect.y, rect.w, rect.h),
});

/** A host view as RN renders it (`RCTView`, `RCTText`, …), measurable through its instance (paper style). */
const host = (type: string, props: Record<string, unknown>, children: Fiber[], rect?: Rect) =>
	fiber(type, props, children, { tag: 5, stateNode: rect ? measurable(rect) : {} });

const comp = (name: string, props: Record<string, unknown>, children: Fiber[]) => {
	const type = Object.assign(() => null, { displayName: name });
	return fiber(type, props, children, { tag: 0 });
};

const text = (value: string) => fiber(null, value, [], { tag: 6 });
const hostRoot = (children: Fiber[]) => fiber(null, null, children, { tag: 3 });

const SCREEN_RECT: Rect = { x: 0, y: 0, w: 390, h: 844 };

type TreeJson = {
	error?: string;
	screen?: string;
	truncated?: boolean;
	components: {
		id: number;
		name: string;
		testID?: string;
		label?: string;
		text?: string;
		parent: number | null;
		rect?: Rect;
		inactive?: true;
	}[];
};

function compile<G>(): (cfg: TreeScriptConfig, g: G) => string {
	return new Function(`return (${TREE_SCRIPT});`)();
}

const config = (extra: Partial<TreeScriptConfig> = {}): TreeScriptConfig => ({
	requestId: "r1",
	binding: "__warden_cb",
	max: 5000,
	all: false,
	guardMs: 1200,
	...extra,
});

type PageGlobal = Record<string, unknown>;

function page(roots: Fiber[][], extra: PageGlobal = {}): PageGlobal {
	const sets = roots.map((children) => ({ current: hostRoot(children) }));
	return {
		__REACT_DEVTOOLS_GLOBAL_HOOK__: {
			renderers: new Map(sets.map((_, id) => [id + 1, {}])),
			getFiberRoots: (id: number) => new Set(sets[id - 1] ? [sets[id - 1]] : []),
		},
		setTimeout,
		clearTimeout,
		...extra,
	};
}

/** Runs the script against `g` and resolves with what the page reported through the binding. */
function run(g: PageGlobal, extra: Partial<TreeScriptConfig> = {}): Promise<TreeJson> {
	return new Promise((resolve, reject) => {
		g.__warden_cb = (payload: string) => {
			const parsed = JSON.parse(payload) as { requestId: string; result: TreeJson };
			resolve(parsed.result);
		};
		try {
			expect(compile<PageGlobal>()(config(extra), g)).toBe("started");
		} catch (error) {
			reject(error);
		}
	});
}

const names = (tree: TreeJson) => tree.components.map((c) => c.testID ?? c.name);

/** Two react-navigation screens: Home (not focused) and Settings (focused). */
function twoScreens(extraSettings: Fiber[] = []) {
	const home = comp("HomeScreen", { navigation: { isFocused: () => false }, route: { name: "Home" } }, [
		host(
			"RCTView",
			{ testID: "home-root" },
			[host("RCTText", { testID: "home-title" }, [text("Home")], { x: 20, y: 80, w: 100, h: 30 })],
			SCREEN_RECT
		),
	]);
	const settings = comp("SettingsScreen", { navigation: { isFocused: () => true }, route: { name: "Settings" } }, [
		host(
			"RCTView",
			{ testID: "settings-root" },
			[
				host(
					"RCTView",
					{ testID: "save", accessibilityLabel: "Save changes" },
					[host("RCTText", {}, [text("Save")], { x: 150, y: 712, w: 90, h: 24 })],
					{ x: 20, y: 700, w: 350, h: 48 }
				),
				...extraSettings,
			],
			SCREEN_RECT
		),
	]);
	return [comp("AppContainer", {}, [comp("RootNavigator", {}, [home, settings])])];
}

describe("tree script: pruning", () => {
	test("keeps the focused screen, drops the inactive one, reports the focused route", async () => {
		const tree = await run(page([twoScreens()]));
		expect(tree.screen).toBe("Settings");
		expect(names(tree)).toEqual(["SettingsScreen", "settings-root", "save", "Text"]);
		expect(tree.components.some((c) => c.testID?.startsWith("home"))).toBe(false);
	});

	test("carries testID, label, text, rect and parent", async () => {
		const tree = await run(page([twoScreens()]));
		const byTestId = (id: string) => tree.components.find((c) => c.testID === id);
		const save = byTestId("save");
		expect(save).toMatchObject({ label: "Save changes", rect: { x: 20, y: 700, w: 350, h: 48 } });
		expect(save?.parent).toBe(byTestId("settings-root")?.id);
		const label = tree.components.find((c) => c.text === "Save");
		expect(label).toMatchObject({ name: "Text", rect: { x: 150, y: 712, w: 90, h: 24 }, parent: save?.id });
		expect(tree.components.map((c) => c.id)).toEqual([0, 1, 2, 3]);
		expect(tree.components[0]?.parent).toBeNull();
	});

	test("all: true keeps the inactive screen, flagged", async () => {
		const tree = await run(page([twoScreens()]), { all: true });
		expect(names(tree)).toContain("home-root");
		expect(tree.components.find((c) => c.testID === "home-root")?.inactive).toBe(true);
		expect(tree.components.find((c) => c.testID === "save")?.inactive).toBeUndefined();
		expect(tree.screen).toBe("Settings");
	});

	test("screen: names one screen's subtree, focused or not", async () => {
		const home = await run(page([twoScreens()]), { screen: "Home" });
		expect(home.screen).toBe("Home");
		expect(home.components.every((c) => c.testID === undefined || c.testID.startsWith("home"))).toBe(true);
		expect(names(home)).toContain("home-title");
		const none = await run(page([twoScreens()]), { screen: "Nope" });
		expect(none.components).toEqual([]);
		expect(none.screen).toBeUndefined();
	});

	test("hidden by display:none (style arrays too), aria-hidden, activityState 0, react-freeze, unfocused pager page", async () => {
		const hidden = (props: Record<string, unknown>, id: string) =>
			host("RCTView", { testID: id, ...props }, [], { x: 0, y: 0, w: 10, h: 10 });
		const tree = await run(
			page([
				[
					host("RCTView", { testID: "root" }, [
						hidden({ style: { display: "none" } }, "display-none"),
						hidden({ style: [{ color: "red" }, [{ display: "none" }]] }, "display-none-nested"),
						hidden({ "aria-hidden": true }, "aria-hidden"),
						hidden({ accessibilityElementsHidden: true }, "a11y-hidden"),
						hidden({ importantForAccessibility: "no-hide-descendants" }, "no-hide"),
						comp("Screen", { activityState: 0 }, [hidden({}, "inactive-screen-child")]),
						comp("Freeze", { freeze: true }, [hidden({}, "frozen-child")]),
						comp("Page", { isPageFocused: false }, [hidden({}, "other-page-child")]),
						comp("Screen", { activityState: 2 }, [hidden({}, "active-screen-child")]),
						comp("Screen", { activityState: 1 }, [hidden({}, "transitioning-child")]),
						hidden({ style: { display: "flex" } }, "flex"),
					]),
				],
			])
		);
		expect(tree.components.map((c) => c.testID).filter(Boolean)).toEqual([
			"root",
			"active-screen-child",
			"transitioning-child",
			"flex",
		]);
	});

	test("all: true keeps hidden subtrees, flagged inactive", async () => {
		const tree = await run(
			page([
				[
					host(
						"RCTView",
						{ testID: "root" },
						[host("RCTView", { testID: "ghost", style: { display: "none" } }, [], { x: 0, y: 0, w: 5, h: 5 })],
						SCREEN_RECT
					),
				],
			]),
			{ all: true }
		);
		expect(tree.components.find((c) => c.testID === "ghost")?.inactive).toBe(true);
	});

	test("a navigation prop whose isFocused throws is treated as unknown, not as unfocused", async () => {
		const screen = comp(
			"Odd",
			{
				navigation: {
					isFocused: () => {
						throw new Error("boom");
					},
				},
				route: { name: "Odd" },
			},
			[host("RCTView", { testID: "odd-child" }, [], SCREEN_RECT)]
		);
		const tree = await run(page([[screen]]));
		expect(names(tree)).toContain("odd-child");
		expect(tree.screen).toBeUndefined();
	});

	test("the deepest focused route names the screen (tabs inside a stack)", async () => {
		const inner = comp("TabScreen", { navigation: { isFocused: () => true }, route: { name: "Profile" } }, [
			host("RCTView", { testID: "profile" }, [], SCREEN_RECT),
		]);
		const outer = comp("StackScreen", { navigation: { isFocused: () => true }, route: { name: "(tabs)" } }, [inner]);
		expect((await run(page([[outer]]))).screen).toBe("Profile");
	});
});

describe("tree script: components", () => {
	test("text is the concatenation of nested strings; nested virtual text does not split the node", async () => {
		const tree = await run(
			page([
				[
					host(
						"RCTText",
						{},
						[
							text("Hello "),
							host("RCTVirtualText", {}, [text("big "), host("RCTVirtualText", {}, [text("world")])]),
							text("!"),
						],
						{ x: 0, y: 0, w: 100, h: 20 }
					),
				],
			])
		);
		expect(tree.components).toHaveLength(1);
		expect(tree.components[0]).toMatchObject({ name: "Text", text: "Hello big world!" });
	});

	test("host type names are the ones people write", async () => {
		const tree = await run(
			page([
				[
					host("RCTView", { testID: "a" }, [], { x: 0, y: 0, w: 1, h: 1 }),
					host("RCTScrollView", { testID: "b" }, [], { x: 10, y: 0, w: 1, h: 1 }),
					host("RCTImageView", { testID: "c" }, [], { x: 20, y: 0, w: 1, h: 1 }),
					host("RCTSinglelineTextInputView", { testID: "d" }, [], { x: 30, y: 0, w: 1, h: 1 }),
					host("RCTMyCustomThing", { testID: "e" }, [], { x: 40, y: 0, w: 1, h: 1 }),
				],
			])
		);
		expect(tree.components.map((c) => c.name)).toEqual([
			"View",
			"ScrollView",
			"Image",
			"TextInput",
			"RCTMyCustomThing",
		]);
	});

	test("forwardRef and memo components are named from what they wrap", async () => {
		const forwardRef = fiber(
			{
				$$typeof: Symbol.for("react.forward_ref"),
				render: function Fancy() {
					return null;
				},
			},
			{ testID: "f" },
			[],
			{ tag: 11 }
		);
		const memo = fiber(
			{ $$typeof: Symbol.for("react.memo"), type: Object.assign(() => null, { displayName: "Row" }) },
			{ testID: "m" },
			[],
			{ tag: 14 }
		);
		const wrap = host("RCTView", {}, [forwardRef, memo], { x: 0, y: 0, w: 1, h: 1 });
		const tree = await run(page([[wrap]]));
		expect(tree.components.map((c) => c.name)).toEqual(["Fancy", "Row"]);
	});

	test("the largest root is the app", async () => {
		const small = [host("RCTView", { testID: "skia" }, [], SCREEN_RECT)];
		const big = [
			host("RCTView", { testID: "app" }, [host("RCTView", { testID: "app-child" }, [], SCREEN_RECT)], SCREEN_RECT),
		];
		const tree = await run(page([small, big]));
		expect(names(tree)).toEqual(["app", "app-child"]);
	});

	test("failures: no DevTools hook, no roots", async () => {
		const noHook = await run({ setTimeout });
		expect(noHook.error).toBe("no-hook");
		const noRoots = await run({
			__REACT_DEVTOOLS_GLOBAL_HOOK__: { renderers: new Map([[1, {}]]), getFiberRoots: () => new Set() },
			setTimeout,
		});
		expect(noRoots.error).toBe("no-roots");
	});
});

describe("tree script: rects", () => {
	const view = (stateNode: unknown, props: Record<string, unknown> = { testID: "x" }) =>
		fiber("RCTView", props, [], { tag: 5, stateNode });

	test("Fabric public instance, paper instance, shadow-node measure, and nothing measurable", async () => {
		const fabricPublic = view(
			{ canonical: { nativeTag: 1, publicInstance: measurable({ x: 1, y: 2, w: 3, h: 4 }) }, node: {} },
			{ testID: "public" }
		);
		const paper = view(measurable({ x: 5, y: 6, w: 7, h: 8 }), { testID: "paper" });
		const shadow = view({ canonical: { nativeTag: 3 }, node: { shadow: true } }, { testID: "shadow" });
		const unmeasurable = view({}, { testID: "none" });
		const tree = await run(
			page([[fabricPublic, paper, shadow, unmeasurable]], {
				nativeFabricUIManager: {
					measure: (_node: unknown, cb: (...n: number[]) => void) => cb(0, 0, 30, 40, 11, 12),
				},
			})
		);
		const rect = (id: string) => tree.components.find((c) => c.testID === id)?.rect;
		expect(rect("public")).toEqual({ x: 1, y: 2, w: 3, h: 4 });
		expect(rect("paper")).toEqual({ x: 5, y: 6, w: 7, h: 8 });
		expect(rect("shadow")).toEqual({ x: 11, y: 12, w: 30, h: 40 });
		expect(tree.components.find((c) => c.testID === "none")).toBeDefined();
		expect(rect("none")).toBeUndefined();
	});

	test("the legacy UIManager is used by native tag when nothing else can measure", async () => {
		const legacy = view({ _nativeTag: 77 }, { testID: "legacy" });
		const tree = await run(
			page([[legacy]], {
				nativeModuleProxy: {
					UIManager: { measureInWindow: (tag: number, cb: (...n: number[]) => void) => cb(tag, 2, 3, 4) },
				},
			})
		);
		expect(tree.components[0]?.rect).toEqual({ x: 77, y: 2, w: 3, h: 4 });
	});

	test("zero-size and non-finite measurements are no rect", async () => {
		const empty = view(measurable({ x: 0, y: 0, w: 0, h: 0 }), { testID: "empty" });
		const nan = view(measurable({ x: Number.NaN, y: 0, w: 5, h: 5 }), { testID: "nan" });
		const tree = await run(page([[empty, nan]]));
		expect(tree.components.map((c) => c.rect)).toEqual([undefined, undefined]);
	});

	test("rounds to one decimal", async () => {
		const tree = await run(page([[view(measurable({ x: 1.23456, y: 2.5, w: 10.04, h: 3 }))]]));
		expect(tree.components[0]?.rect).toEqual({ x: 1.2, y: 2.5, w: 10, h: 3 });
	});

	test("a measure callback that never fires does not hang: the guard delivers what it has", async () => {
		const never = view({ measureInWindow: () => undefined }, { testID: "never" });
		const fine = view(measurable({ x: 1, y: 1, w: 2, h: 2 }), { testID: "fine" });
		const started = Date.now();
		const tree = await run(page([[never, fine]]), { guardMs: 30 });
		expect(Date.now() - started).toBeLessThan(500);
		expect(tree.components.find((c) => c.testID === "fine")?.rect).toBeDefined();
		expect(tree.components.find((c) => c.testID === "never")?.rect).toBeUndefined();
	});

	test("late callbacks after the guard are ignored", async () => {
		let late: (() => void) | undefined;
		const slow = view(
			{ measureInWindow: (cb: (...n: number[]) => void) => (late = () => cb(1, 1, 1, 1)) },
			{ testID: "slow" }
		);
		const reports: string[] = [];
		const g = page([[slow]]);
		g.__warden_cb = (payload: string) => reports.push(payload);
		compile<PageGlobal>()(config({ guardMs: 20 }), g);
		await Bun.sleep(60);
		late?.();
		expect(reports).toHaveLength(1);
	});

	test("components with neither a rect nor a testID are dropped", async () => {
		const noRect = host("RCTText", { accessibilityLabel: "label only" }, []);
		const tree = await run(
			page([[noRect, view(measurable({ x: 1, y: 1, w: 1, h: 1 }), { accessibilityLabel: "labelled" })]])
		);
		expect(tree.components.map((c) => c.label)).toEqual(["labelled"]);
	});
});

describe("tree script: parent dedup", () => {
	const r = (extra: Partial<Rect> = {}): Rect => ({ x: 0, y: 100, w: 200, h: 50, ...extra });

	test("a screen root is kept even when it wraps one view at its rect", async () => {
		const tree = await run(
			page([
				[
					comp("Wrapper", { navigation: { isFocused: () => true }, route: { name: "S" } }, [
						host("RCTView", { testID: "inner" }, [], r()),
					]),
				],
			])
		);
		expect(tree.components.map((c) => [c.name, c.testID, c.parent])).toEqual([
			["Wrapper", undefined, null],
			["View", "inner", 0],
		]);
	});

	test("a composite and its host carrying the same testID are one component, named after the composite", async () => {
		const tree = await run(
			page([
				[
					comp("Button", { testID: "buy" }, [
						host("RCTView", { testID: "buy" }, [host("RCTText", {}, [text("Buy")], r())], r()),
					]),
				],
			])
		);
		expect(tree.components).toHaveLength(1);
		expect(tree.components[0]).toMatchObject({ name: "Button", testID: "buy", text: "Buy" });
	});

	test("a labelled parent absorbs its only text child at the same rect", async () => {
		const tree = await run(
			page([
				[
					host(
						"RCTView",
						{ testID: "chip", accessibilityLabel: "Chip" },
						[host("RCTText", {}, [text("New")], r())],
						r()
					),
				],
			])
		);
		expect(tree.components).toHaveLength(1);
		expect(tree.components[0]).toMatchObject({ testID: "chip", label: "Chip", text: "New" });
	});

	test("different rects or two children keep the structure", async () => {
		const tree = await run(
			page([
				[
					host(
						"RCTView",
						{ testID: "row" },
						[
							host("RCTText", {}, [text("A")], r({ x: 10, w: 50 })),
							host("RCTText", {}, [text("B")], r({ x: 100, w: 50 })),
						],
						r()
					),
					host("RCTView", { testID: "solo" }, [host("RCTText", {}, [text("C")], r({ y: 200, w: 20 }))], r({ y: 200 })),
				],
			])
		);
		expect(tree.components.map((c) => [c.testID ?? c.text, c.parent])).toEqual([
			["row", null],
			["A", 0],
			["B", 0],
			["solo", null],
			["C", 3],
		]);
	});

	test("a differing testID on the only child is kept", async () => {
		const tree = await run(
			page([[host("RCTView", { testID: "outer" }, [host("RCTView", { testID: "inner" }, [], r())], r())]])
		);
		expect(names(tree)).toEqual(["outer", "inner"]);
	});

	test("rects within a pixel count as the same", async () => {
		const tree = await run(
			page([[host("RCTView", { testID: "a" }, [host("RCTText", {}, [text("x")], r({ x: 0.6, h: 49.5 }))], r())]])
		);
		expect(tree.components).toHaveLength(1);
	});
});

describe("tree script: bounds", () => {
	const many = (n: number) =>
		host(
			"RCTView",
			{ testID: "list" },
			Array.from({ length: n }, (_, i) =>
				host("RCTView", { testID: `item-${i}` }, [], { x: 0, y: i * 10, w: 50, h: 9 })
			),
			{ x: 0, y: 0, w: 50, h: n * 10 }
		);

	test("max cuts the preorder and says so; every kept parent is kept", async () => {
		const tree = await run(page([[many(10)]]), { max: 4 });
		expect(tree.truncated).toBe(true);
		expect(tree.components.map((c) => c.testID)).toEqual(["list", "item-0", "item-1", "item-2"]);
		expect(tree.components.every((c) => c.parent === null || c.parent < c.id)).toBe(true);
	});

	test("under the limit nothing is truncated", async () => {
		const tree = await run(page([[many(3)]]), { max: 10 });
		expect(tree.truncated).toBe(false);
		expect(tree.components).toHaveLength(4);
	});

	test("never more than 5000 components, whatever max asks for", async () => {
		const tree = await run(page([[many(5200)]]), { max: 100000 });
		expect(tree.components).toHaveLength(5000);
		expect(tree.truncated).toBe(true);
	});
});

describe("tree script: delivery", () => {
	test("without the binding the result is left in a page global for polling", async () => {
		const g = page([[host("RCTView", { testID: "only" }, [], SCREEN_RECT)]]);
		compile<PageGlobal>()(config({ requestId: "poll-1" }), g);
		const stored = g.__warden_tree_results as Record<string, string>;
		expect(JSON.parse(stored["poll-1"] ?? "null").components).toHaveLength(1);
	});

	test("with the binding nothing is left behind", async () => {
		const g = page([[host("RCTView", { testID: "only" }, [], SCREEN_RECT)]]);
		await run(g);
		expect(g.__warden_tree_results).toBeUndefined();
	});

	test("a crash inside the script is reported, not thrown", async () => {
		const g = page([[host("RCTView", { testID: "x" }, [], SCREEN_RECT)]]);
		(g.__REACT_DEVTOOLS_GLOBAL_HOOK__ as { getFiberRoots: unknown }).getFiberRoots = () => {
			throw new Error("hook exploded");
		};
		const tree = await run(g);
		expect(tree.error).toBeDefined();
	});

	test("stays plain ES2015 (Hermes evaluates it untranspiled)", () => {
		expect(TREE_SCRIPT).not.toMatch(/\basync\b|\bawait\b|=>|\?\.|\?\?|\bclass\b|`/);
	});

	test("install expression embeds the config and a global-object fallback", () => {
		const expression = treeInstallExpression(config({ requestId: "abc" }));
		expect(expression).toContain('"requestId":"abc"');
		expect(expression).toContain("globalThis");
	});
});
