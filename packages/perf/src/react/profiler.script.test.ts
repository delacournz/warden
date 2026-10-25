import { describe, expect, test } from "bun:test";
import { BOOTSTRAP_SCRIPT } from "./bootstrap.script";
import { PROFILER_GLOBAL, PROFILER_SCRIPT } from "./profiler.script";
import { componentType, type FakeFiber, fakeGlobal, fakeHook, fakeRenderer, runScript } from "./react.testing";

type Reply = Record<string, unknown>;
const call = (cfg: Record<string, unknown>, g: ReturnType<typeof fakeGlobal>): Reply =>
	JSON.parse(String(runScript(PROFILER_SCRIPT, cfg, g))) as Reply;

describe("script source", () => {
	test("is Hermes-safe text: no template literals, backslashes, arrows or optional chaining", () => {
		for (const script of [PROFILER_SCRIPT, BOOTSTRAP_SCRIPT]) {
			expect(script).not.toContain("`");
			expect(script).not.toContain("\\");
			expect(script).not.toContain("=>");
			expect(script).not.toContain("?.");
			expect(script).not.toMatch(/\b(let|const)\s/);
		}
	});
});

describe("start", () => {
	test("wraps every renderer's start/stopProfiling, records the owner and starts with change descriptions", () => {
		const r = fakeRenderer();
		const g = fakeGlobal(fakeHook([r]));
		const reply = call({ action: "start", owner: "agent:a" }, g);
		expect(reply).toMatchObject({ ok: true, dev: true, bootstrapped: false });
		expect(r.calls).toEqual(["start"]);
		expect(r.isProfiling).toBe(true);
		const state = g[PROFILER_GLOBAL] as { owner: { owner: string }; profiling: boolean; v: number };
		expect(state).toMatchObject({ v: 1, profiling: true, owner: { owner: "agent:a" } });
	});

	test("idempotent: a second install does not double-wrap or double-patch", () => {
		const r = fakeRenderer();
		const hook = fakeHook([r]);
		const g = fakeGlobal(hook);
		call({ action: "start", owner: "a" }, g);
		const patched = hook.onCommitFiberRoot;
		call({ action: "start", owner: "a" }, g);
		expect(hook.onCommitFiberRoot).toBe(patched);
		expect(r.calls.filter((c) => c === "start")).toHaveLength(2);
	});

	test("a second owner is refused with session_active unless --force", () => {
		const g = fakeGlobal(fakeHook([fakeRenderer()]));
		call({ action: "start", owner: "agent:a" }, g);
		expect(call({ action: "start", owner: "agent:b" }, g)).toMatchObject({
			ok: false,
			code: "session_active",
			owner: "agent:a",
		});
		expect(call({ action: "start", owner: "agent:b", force: true }, g)).toMatchObject({ ok: true });
	});

	test("a stale owner marker (five minutes without a heartbeat) is taken over", () => {
		const g = fakeGlobal(fakeHook([fakeRenderer()]));
		call({ action: "start", owner: "agent:a" }, g);
		const state = g[PROFILER_GLOBAL] as { owner: { startedAt: number; heartbeat: number } };
		state.owner.startedAt -= 301_000;
		state.owner.heartbeat -= 301_000;
		expect(call({ action: "start", owner: "agent:b" }, g)).toMatchObject({ ok: true });
	});

	test("release build: __DEV__ false, or no hook", () => {
		const off = fakeGlobal(fakeHook([fakeRenderer()]), { __DEV__: false });
		expect(call({ action: "start", owner: "a" }, off)).toMatchObject({ ok: false, code: "release_build" });
		expect(call({ action: "start", owner: "a" }, fakeGlobal(undefined))).toMatchObject({
			ok: false,
			code: "release_build",
		});
	});
});

describe("bootstrap", () => {
	type Mod = { verboseName: string };
	const registry = (mods: Record<number, Mod>, loaded: Record<number, unknown>) => {
		const req = Object.assign((id: number) => loaded[id], {
			getModules: () => new Map(Object.entries(mods).map(([k, v]) => [Number(k), v])),
		});
		return req;
	};
	const platform = (minor: number) => ({
		default: { constants: { reactNativeVersion: { major: 0, minor, patch: 1 } } },
	});

	test("no renderer interfaces: attaches react-devtools-core with no-op handlers", () => {
		const hook = fakeHook([]);
		const r = fakeRenderer();
		let args: Record<string, unknown> | undefined;
		const core = {
			connectWithCustomMessagingProtocol: (a: Record<string, unknown>) => {
				args = a;
				hook.rendererInterfaces.set(1, r);
			},
		};
		const g = fakeGlobal(hook, {
			__r: registry(
				{
					1: { verboseName: "node_modules/react-native/Libraries/Utilities/Platform.ios.js" },
					2: { verboseName: "node_modules/react-devtools-core/dist/backend.js" },
				},
				{ 1: platform(76), 2: core }
			),
		});
		expect(call({ action: "start", owner: "a" }, g)).toMatchObject({ ok: true, bootstrapped: true, rn: "0.76.1" });
		expect(typeof args?.onSubscribe).toBe("function");
		expect(r.calls).toEqual(["start"]);
	});

	test("react native below 0.74 is rn_too_old", () => {
		const g = fakeGlobal(fakeHook([fakeRenderer()]), {
			__r: registry(
				{ 1: { verboseName: "node_modules/react-native/Libraries/Utilities/Platform.android.js" } },
				{ 1: platform(73) }
			),
		});
		expect(call({ action: "start", owner: "a" }, g)).toMatchObject({ ok: false, code: "rn_too_old" });
	});

	test("no devtools-core in the bundle, or one that attaches nothing, is devtools_backend_missing", () => {
		const bare = fakeGlobal(fakeHook([]), { __r: registry({}, {}) });
		expect(call({ action: "start", owner: "a" }, bare)).toMatchObject({ ok: false, code: "devtools_backend_missing" });
		const inert = fakeGlobal(fakeHook([]), {
			__r: registry(
				{ 2: { verboseName: "node_modules/react-devtools-core/dist/backend.js" } },
				{ 2: { connectWithCustomMessagingProtocol: () => undefined } }
			),
		});
		expect(call({ action: "start", owner: "a" }, inert)).toMatchObject({ ok: false, code: "devtools_backend_missing" });
		expect(call({ action: "start", owner: "a" }, fakeGlobal(fakeHook([]))).hint).toContain("react-devtools-core");
	});
});

describe("commit hook", () => {
	const fiber = (id: number, name: string, flags: number, over: Partial<FakeFiber> = {}): FakeFiber => ({
		tag: 0,
		type: componentType(name),
		flags,
		subtreeFlags: 0,
		alternate: {} as FakeFiber,
		child: null,
		sibling: null,
		id,
		...over,
	});

	test("calls the original first, then names rendered fibers and their parents, skipping idle subtrees", () => {
		const r = fakeRenderer();
		const hook = fakeHook([r]);
		const g = fakeGlobal(hook);
		call({ action: "start", owner: "a" }, g);
		const leaf = fiber(3, "Leaf", 1);
		const idleLeaf = fiber(9, "IdleLeaf", 0);
		const idle = fiber(4, "Idle", 0, { child: idleLeaf });
		const memo = fiber(2, "Row", 1, { tag: 15, child: leaf, sibling: idle });
		leaf.sibling = null;
		const root = fiber(1, "Screen", 1, { subtreeFlags: 1, child: memo });
		expect(hook.onCommitFiberRoot(1, { current: root })).toBe("original");
		const state = g[PROFILER_GLOBAL] as {
			names: Record<number, string>;
			parents: Record<number, number>;
			memo: Record<number, number>;
		};
		expect(state.names).toMatchObject({ 1: "Screen", 2: "Row", 3: "Leaf" });
		expect(state.parents).toMatchObject({ 2: 1, 3: 2 });
		expect(state.memo).toEqual({ 2: 1 });
		expect(state.names[9]).toBeUndefined();
	});

	test("does nothing while not profiling", () => {
		const hook = fakeHook([fakeRenderer()]);
		const g = fakeGlobal(hook);
		call({ action: "start", owner: "a" }, g);
		(g[PROFILER_GLOBAL] as { profiling: boolean }).profiling = false;
		hook.onCommitFiberRoot(1, { current: fiber(1, "Screen", 1) });
		expect((g[PROFILER_GLOBAL] as { names: object }).names).toEqual({});
	});
});

describe("stop", () => {
	test("flattens getProfilingData: durations, change descriptions, updaters, names, compiler flags", () => {
		const r = fakeRenderer();
		const g = fakeGlobal(fakeHook([r]));
		call({ action: "start", owner: "a" }, g);
		const out = call({ action: "stop", owner: "a" }, g) as {
			ok: boolean;
			roots: Array<{ name: string; commits: Array<Record<string, unknown>> }>;
			names: Record<string, string>;
			compiled: Record<string, number>;
			anchor: Record<string, number>;
		};
		expect(out.ok).toBe(true);
		expect(r.calls).toEqual(["start", "stop"]);
		expect(out.names).toEqual({ "4": "FeedList", "10": "FeedRow", "11": "ThemedText" });
		expect(out.compiled).toEqual({ "4": 1 });
		const first = out.roots[0]?.commits[0];
		expect(first).toMatchObject({ t: 120, dur: 40, pas: 2, upd: ["FeedList"] });
		expect(first?.c).toContainEqual([10, { p: ["onPress", "style"], st: null, h: null, x: null, f: 0 }]);
		expect(out.roots[0]?.commits[1]).toMatchObject({ upd: [], c: [] });
		expect(out.anchor.stoppedWall).toBeGreaterThanOrEqual(out.anchor.startedWall);
		expect((g[PROFILER_GLOBAL] as { owner: unknown }).owner).toBeNull();
	});

	test("reports _debugSource of components found in the live fiber tree", () => {
		const r = fakeRenderer();
		const hook = fakeHook([r]);
		const g = fakeGlobal(hook);
		call({ action: "start", owner: "a" }, g);
		const row: FakeFiber = {
			tag: 0,
			type: componentType("FeedRow"),
			flags: 0,
			subtreeFlags: 0,
			alternate: null,
			child: null,
			sibling: null,
			_debugSource: { fileName: "/w/src/FeedRow.tsx", lineNumber: 21 },
		};
		hook.roots.add({ current: row });
		const out = call({ action: "stop", owner: "a" }, g) as { sources: Record<string, unknown> };
		expect(out.sources).toEqual({ FeedRow: { file: "/w/src/FeedRow.tsx", line: 21 } });
	});

	test("nothing running is not_profiling; another owner's profile is session_active", () => {
		const g = fakeGlobal(fakeHook([fakeRenderer()]));
		expect(call({ action: "stop", owner: "a" }, g)).toMatchObject({ ok: false, code: "not_profiling" });
		call({ action: "start", owner: "a" }, g);
		expect(call({ action: "stop", owner: "b" }, g)).toMatchObject({ ok: false, code: "session_active", owner: "a" });
		expect(call({ action: "stop", owner: "b", force: true }, g)).toMatchObject({ ok: true });
	});

	test("status says who holds it", () => {
		const g = fakeGlobal(fakeHook([fakeRenderer()]));
		expect(call({ action: "status" }, g)).toMatchObject({ ok: true, profiling: false, owner: null, renderers: 1 });
		call({ action: "start", owner: "a" }, g);
		expect(call({ action: "status" }, g)).toMatchObject({ profiling: true, owner: { owner: "a" } });
	});
});
