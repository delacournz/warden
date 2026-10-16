import { describe, expect, test } from "bun:test";
import { ok, type Result } from "@delacour/warden-types/result";
import { type DevtoolsResult, devtoolsErr, type EvaluateError, type ReactTree } from "./devtools.types";
import type { DevtoolsSession } from "./session";
import { fetchTree, formatTree } from "./tree";

type TreeSession = Pick<DevtoolsSession, "evaluate" | "evaluateWithBinding" | "bindingAvailable">;

type FakeFiber = {
	type: unknown;
	tag: number;
	memoizedProps: unknown;
	child: FakeFiber | null;
	sibling: FakeFiber | null;
	return: FakeFiber | null;
	stateNode: unknown;
};

function fiber(
	tag: number,
	type: unknown,
	props: unknown,
	children: FakeFiber[],
	stateNode: unknown = null
): FakeFiber {
	const node: FakeFiber = { type, tag, memoizedProps: props, child: null, sibling: null, return: null, stateNode };
	let previous: FakeFiber | undefined;
	for (const child of children) {
		child.return = node;
		if (previous) previous.sibling = child;
		else node.child = child;
		previous = child;
	}
	return node;
}

const measurable = (x: number, y: number, w: number, h: number) => ({
	measureInWindow: (cb: (...n: number[]) => void) => cb(x, y, w, h),
});

/** `Pay` button (10,20 100x40.5) with its label, inside an unmeasured container. */
function appGlobal(): Record<string, unknown> {
	const label = fiber(6, null, "Pay", []);
	const text = fiber(5, "RCTText", {}, [label], measurable(20, 30, 40, 20));
	const button = fiber(
		5,
		"RCTView",
		{ testID: "pay", accessibilityLabel: "Pay now" },
		[text],
		measurable(10, 20, 100, 40.5)
	);
	const root = fiber(3, null, null, [fiber(5, "RCTView", { testID: "app" }, [button])]);
	return {
		__REACT_DEVTOOLS_GLOBAL_HOOK__: {
			renderers: new Map([[1, {}]]),
			getFiberRoots: () => new Set([{ current: root }]),
		},
		setTimeout,
		clearTimeout,
	};
}

/** Runs the expression against `page` with `globalThis` shadowed, as the app's JS context would. */
function runIn(page: Record<string, unknown>, expression: string): unknown {
	return new Function("globalThis", `return ${expression};`)(page);
}

type Stub = {
	session: TreeSession;
	page: Record<string, unknown>;
	expressions: string[];
};

function stubSession(
	options: { binding: boolean; page?: Record<string, unknown>; bindingError?: DevtoolsResult<unknown> } = {
		binding: true,
	}
): Stub {
	const page = options.page ?? appGlobal();
	const expressions: string[] = [];
	const session: TreeSession = {
		bindingAvailable: options.binding,
		async evaluate(expression): Promise<Result<unknown, EvaluateError>> {
			expressions.push(expression);
			try {
				return ok(runIn(page, expression));
			} catch (error) {
				return { success: false, error: { message: String(error), code: "eval_failed" } };
			}
		},
		evaluateWithBinding(script) {
			expressions.push(script);
			if (options.bindingError) return Promise.resolve(options.bindingError);
			return new Promise((resolve) => {
				page.__warden_cb = (payload: string) => resolve(ok(JSON.parse(payload)));
				runIn(page, script);
			});
		},
	};
	return { session, page, expressions };
}

const noWait = async () => undefined;

async function treeOf(stub: Stub, options: Parameters<typeof fetchTree>[1] = {}): Promise<ReactTree> {
	const result = await fetchTree(stub.session, options, { sleep: noWait });
	if (!result.success) throw new Error(`fetchTree failed: ${result.error.code} ${result.error.message}`);
	return result.data;
}

describe("fetchTree", () => {
	test("through the binding: components with rects as x/y/width/height", async () => {
		const tree = await treeOf(stubSession({ binding: true }));
		expect(tree.truncated).toBe(false);
		expect(tree.components.map((c) => [c.name, c.testID, c.label, c.text, c.parent])).toEqual([
			["View", "app", undefined, undefined, null],
			["View", "pay", "Pay now", undefined, 0],
			["Text", undefined, undefined, "Pay", 1],
		]);
		expect(tree.components[1]?.rect).toEqual({ x: 10, y: 20, width: 100, height: 40.5 });
	});

	test("without a binding it polls the page global and clears it", async () => {
		const stub = stubSession({ binding: false });
		const tree = await treeOf(stub);
		expect(tree.components).toHaveLength(3);
		expect(stub.page.__warden_tree_results).toEqual({});
		expect(stub.expressions.length).toBeGreaterThanOrEqual(2);
	});

	test("polls until the page has answered", async () => {
		const stub = stubSession({ binding: false });
		let polls = 0;
		const inner = stub.session.evaluate;
		stub.session.evaluate = async (expression, options) => {
			if (!expression.includes("__warden_tree_results") || !expression.includes("delete"))
				return inner(expression, options);
			polls += 1;
			return polls < 3 ? ok(null) : inner(expression, options);
		};
		const tree = await treeOf(stub);
		expect(polls).toBe(3);
		expect(tree.components).toHaveLength(3);
	});

	test("a missing binding falls back to polling", async () => {
		const stub = stubSession({ binding: true, bindingError: devtoolsErr("binding_unavailable", "legacy Hermes") });
		const tree = await treeOf(stub);
		expect(tree.components).toHaveLength(3);
	});

	test("pixelRatio scales rects to the driver's pixels", async () => {
		const tree = await treeOf(stubSession({ binding: true }), { pixelRatio: 2.625 });
		expect(tree.components[1]?.rect).toEqual({ x: 26.3, y: 52.5, width: 262.5, height: 106.3 });
	});

	test("options reach the page script", async () => {
		const stub = stubSession({ binding: true });
		await treeOf(stub, { max: 1, all: true, screen: "Home" });
		const sent = stub.expressions.at(0) ?? "";
		expect(sent).toContain('"max":1');
		expect(sent).toContain('"all":true');
		expect(sent).toContain('"screen":"Home"');
	});

	test("max truncates and says so", async () => {
		const tree = await treeOf(stubSession({ binding: true }), { max: 1 });
		expect(tree.components).toHaveLength(1);
		expect(tree.truncated).toBe(true);
	});

	test("no DevTools hook is devtools_unavailable", async () => {
		const result = await fetchTree(stubSession({ binding: true, page: { setTimeout } }).session, {}, { sleep: noWait });
		expect(result).toEqual(devtoolsErr("devtools_unavailable", "React DevTools hook not present (release build?)"));
	});

	test("a hook with no mounted root is devtools_unavailable", async () => {
		const page = {
			__REACT_DEVTOOLS_GLOBAL_HOOK__: { renderers: new Map(), getFiberRoots: () => new Set() },
			setTimeout,
		};
		const result = await fetchTree(stubSession({ binding: false, page }).session, {}, { sleep: noWait });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("devtools_unavailable");
	});

	test("a script crash is eval_failed with the message", async () => {
		const page = {
			__REACT_DEVTOOLS_GLOBAL_HOOK__: {
				getFiberRoots: () => {
					throw new Error("hook exploded");
				},
			},
			setTimeout,
		};
		const result = await fetchTree(stubSession({ binding: true, page }).session, {}, { sleep: noWait });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("eval_failed");
			expect(result.error.message).toContain("hook exploded");
		}
	});

	test("a payload of the wrong shape is cdp_protocol", async () => {
		const session: TreeSession = {
			bindingAvailable: true,
			evaluate: async () => ok(undefined),
			evaluateWithBinding: async (_script, requestId) => ok({ requestId, result: { components: "nope" } }),
		};
		const result = await fetchTree(session, {}, { sleep: noWait });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("cdp_protocol");
	});

	test("a failing evaluate is passed on with its code", async () => {
		const session: TreeSession = {
			bindingAvailable: false,
			evaluate: async () => ({ success: false, error: { message: "socket closed", code: "cdp_closed" } }),
			evaluateWithBinding: async () => devtoolsErr("cdp_closed", "unused"),
		};
		const result = await fetchTree(session, {}, { sleep: noWait });
		expect(result).toEqual(devtoolsErr("cdp_closed", "socket closed"));
	});

	test("a binding failure other than unavailable is passed on", async () => {
		const stub = stubSession({ binding: true, bindingError: devtoolsErr("cdp_timeout", "no callback") });
		expect(await fetchTree(stub.session, {}, { sleep: noWait })).toEqual(devtoolsErr("cdp_timeout", "no callback"));
	});

	test("polling gives up at the timeout", async () => {
		let clock = 0;
		const session: TreeSession = {
			bindingAvailable: false,
			evaluate: async () => ok(null),
			evaluateWithBinding: async () => devtoolsErr("cdp_closed", "unused"),
		};
		const result = await fetchTree(
			session,
			{ timeoutMs: 1000 },
			{
				sleep: async (ms) => {
					clock += ms;
				},
				now: () => clock,
			}
		);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("cdp_timeout");
		expect(clock).toBeGreaterThanOrEqual(1000);
	});
});

describe("formatTree", () => {
	const tree: ReactTree = {
		screen: "Settings",
		truncated: false,
		components: [
			{ id: 0, name: "SettingsScreen", parent: null, rect: { x: 0, y: 0, width: 390, height: 844 } },
			{
				id: 1,
				name: "View",
				testID: "save",
				label: "Save changes",
				parent: 0,
				rect: { x: 20, y: 700.5, width: 350, height: 48 },
			},
			{ id: 2, name: "Text", text: "Save", parent: 1, rect: { x: 150, y: 712, width: 90, height: 24 } },
			{ id: 3, name: "View", testID: "ghost", parent: 0 },
			{ id: 4, name: "View", testID: "old", parent: null, inactive: true, rect: { x: 0, y: 0, width: 5, height: 5 } },
		],
	};

	test("indents by depth and shows testID, label or text, and rect", () => {
		expect(formatTree(tree)).toEqual([
			"SettingsScreen (0,0 390×844)",
			'  View testID=save "Save changes" (20,700.5 350×48)',
			'    Text "Save" (150,712 90×24)',
		]);
	});

	test("all adds unmeasured and inactive components, marked", () => {
		expect(formatTree(tree, { all: true })).toEqual([
			"SettingsScreen (0,0 390×844)",
			'  View testID=save "Save changes" (20,700.5 350×48)',
			'    Text "Save" (150,712 90×24)',
			"  View testID=ghost",
			"View testID=old (0,0 5×5) [inactive]",
		]);
	});

	test("max cuts the list and says how many were left out", () => {
		expect(formatTree(tree, { max: 2 })).toEqual([
			"SettingsScreen (0,0 390×844)",
			'  View testID=save "Save changes" (20,700.5 350×48)',
			"... 1 more",
		]);
	});

	test("long text is shortened", () => {
		const long: ReactTree = {
			truncated: false,
			components: [
				{ id: 0, name: "Text", text: "x".repeat(100), parent: null, rect: { x: 0, y: 0, width: 1, height: 1 } },
			],
		};
		const line = formatTree(long)[0] ?? "";
		expect(line.length).toBeLessThan(100);
		expect(line).toContain("...");
	});
});
