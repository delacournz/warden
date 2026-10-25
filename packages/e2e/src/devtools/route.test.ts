import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import { readRoute, routeKey } from "./route";
import { ROUTE_SCRIPT } from "./route.script";

type Fiber = {
	memoizedProps: unknown;
	child: Fiber | null;
	sibling: Fiber | null;
};

function fiber(props: unknown, children: Fiber[] = []): Fiber {
	const node: Fiber = { memoizedProps: props, child: null, sibling: null };
	let previous: Fiber | undefined;
	for (const child of children) {
		if (previous) previous.sibling = child;
		else node.child = child;
		previous = child;
	}
	return node;
}

const screen = (name: string, focused: boolean, children: Fiber[] = [], key = name) =>
	fiber({ route: { name, key }, navigation: { isFocused: () => focused } }, children);

function pageOf(...roots: Fiber[]): Record<string, unknown> {
	const sets = roots.map((child) => ({ current: fiber(null, [child]) }));
	return {
		__REACT_DEVTOOLS_GLOBAL_HOOK__: {
			renderers: new Map(sets.map((_, id) => [id + 1, {}])),
			getFiberRoots: (id: number) => new Set(sets[id - 1] ? [sets[id - 1]] : []),
		},
	};
}

function run(g: Record<string, unknown>): { route?: string[]; error?: string } {
	const fn: (g: Record<string, unknown>) => string = new Function(`return (${ROUTE_SCRIPT});`)();
	return JSON.parse(fn(g));
}

describe("route script", () => {
	test("the focused screens from the outermost navigator to the deepest", () => {
		const tabs = screen("(tabs)", true, [screen("index", false), screen("todos", true, [fiber({ testID: "x" })])]);
		expect(run(pageOf(fiber({}, [tabs, screen("sign-in", false)]))).route).toEqual(["(tabs)", "todos"]);
	});

	test("an unfocused stack screen hides what is inside it", () => {
		const hiddenTabs = screen("(tabs)", false, [screen("todos", true)]);
		expect(run(pageOf(fiber({}, [hiddenTabs, screen("todo/[id]", true)]))).route).toEqual(["todo/[id]"]);
	});

	test("a wrapper carrying the same route key counts once", () => {
		const inner = screen("welcome", true, [], "k1");
		expect(run(pageOf(screen("welcome", true, [inner], "k1"))).route).toEqual(["welcome"]);
	});

	test("frozen subtrees are skipped", () => {
		const frozen = fiber({ freeze: true }, [screen("old", true)]);
		expect(run(pageOf(fiber({}, [frozen, screen("now", true)]))).route).toEqual(["now"]);
	});

	test("no hook and no roots are reported", () => {
		expect(run({}).error).toBe("no-hook");
		expect(
			run({ __REACT_DEVTOOLS_GLOBAL_HOOK__: { renderers: new Map(), getFiberRoots: () => new Set() } }).error
		).toBe("no-roots");
	});
});

describe("routeKey", () => {
	test("joins names and drops the expo-router wrapper", () => {
		expect(routeKey(["__root", "(tabs)", "settings"])).toBe("(tabs)/settings");
		expect(routeKey([])).toBeUndefined();
	});
});

describe("readRoute", () => {
	const facet = (data: unknown) => ({ evaluate: async () => ok(data) });

	test("the route key from the script's reply", async () => {
		const read = await readRoute(facet(JSON.stringify({ route: ["(tabs)", "todos"] })));
		expect(read).toEqual({ success: true, data: "(tabs)/todos" });
	});

	test("a release build is devtools_unavailable", async () => {
		const read = await readRoute(facet(JSON.stringify({ error: "no-hook" })));
		expect(!read.success && read.error.code).toBe("devtools_unavailable");
	});

	test("a reply that is not the script's is a protocol error", async () => {
		const read = await readRoute(facet("nope"));
		expect(!read.success && read.error.code).toBe("cdp_protocol");
	});

	test("an evaluate failure keeps its code", async () => {
		const read = await readRoute({
			evaluate: async () => ({ success: false, error: { message: "slow", code: "cdp_timeout" } }),
		});
		expect(!read.success && read.error.code).toBe("cdp_timeout");
	});
});
