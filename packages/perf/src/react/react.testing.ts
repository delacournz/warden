import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeCdp, jsFixtures } from "../js/js.testing";
import { type CommitsFile, commitsFileSchema } from "./react.types";

const FIXTURES = join(import.meta.dir, "../../fixtures");

type ProfilingFixture = { profilingData: unknown; displayNames: Record<string, string> };

/** A renderer interface the way the DevTools backend exposes it, recording profiling calls. */
export type FakeRenderer = {
	calls: string[];
	isProfiling: boolean;
	startProfiling: (record?: boolean) => void;
	stopProfiling: () => void;
	getProfilingData: () => unknown;
	getDisplayNameForElementID: (id: number) => string | null;
	getFiberIDUnsafe?: (fiber: FakeFiber) => number | null;
};

export type FakeFiber = {
	tag: number;
	type: (() => void) | null;
	flags: number;
	subtreeFlags: number;
	alternate: FakeFiber | null;
	child: FakeFiber | null;
	sibling: FakeFiber | null;
	_debugSource?: { fileName: string; lineNumber: number };
	id?: number;
};

export type FakeHook = {
	rendererInterfaces: Map<number, FakeRenderer>;
	onCommitFiberRoot: (rendererId: number, root: { current: FakeFiber }) => unknown;
	getFiberRoots: (rendererId: number) => Set<{ current: FakeFiber }>;
	commitLog: number[];
	roots: Set<{ current: FakeFiber }>;
};

export type FakeGlobal = Record<string, unknown> & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: FakeHook };

export class ReactFixtures {
	loadCommitsFixture(): CommitsFile {
		return commitsFileSchema.parse(JSON.parse(readFileSync(join(FIXTURES, "react-commits.json"), "utf8")));
	}

	loadProfilingFixture(): ProfilingFixture {
		return JSON.parse(readFileSync(join(FIXTURES, "react-profiling-data.json"), "utf8")) as ProfilingFixture;
	}

	/** A component type: a function carrying `name`, as React sees it. */
	componentType(name: string): () => void {
		return Object.defineProperty(() => undefined, "name", { value: name });
	}

	fakeRenderer(fixture: ProfilingFixture = this.loadProfilingFixture()): FakeRenderer {
		const r: FakeRenderer = {
			calls: [],
			isProfiling: false,
			startProfiling() {
				r.calls.push("start");
				r.isProfiling = true;
			},
			stopProfiling() {
				r.calls.push("stop");
				r.isProfiling = false;
			},
			getProfilingData: () => fixture.profilingData,
			getDisplayNameForElementID: (id) => fixture.displayNames[String(id)] ?? null,
			getFiberIDUnsafe: (fiber) => fiber.id ?? null,
		};
		return r;
	}

	fakeHook(renderers: FakeRenderer[]): FakeHook {
		const hook: FakeHook = {
			rendererInterfaces: new Map(renderers.map((r, i) => [i + 1, r])),
			commitLog: [],
			roots: new Set(),
			onCommitFiberRoot(rendererId) {
				hook.commitLog.push(rendererId);
				return "original";
			},
			getFiberRoots: () => hook.roots,
		};
		return hook;
	}

	/** A Hermes global: `__DEV__` on, the hook installed, `performance.now` ticking. */
	fakeGlobal(hook: FakeHook | undefined, extra: Record<string, unknown> = {}): FakeGlobal {
		let tick = 1000;
		return {
			__DEV__: true,
			...(hook === undefined ? {} : { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook }),
			performance: { now: () => (tick += 5) },
			...extra,
		};
	}

	/** Run an injected script's `(SCRIPT)(config, globalObject)` against `g`, the way `Runtime.evaluate` would. */
	runScript(script: string, config: unknown, g: FakeGlobal): unknown {
		return new Function("g", `return (${script})(${JSON.stringify(config)}, g);`)(g);
	}

	/** A CDP whose `Runtime.evaluate` runs the expression in-process with `globalThis` bound to `g`. */
	runtimeCdp(g: FakeGlobal): FakeCdp {
		return jsFixtures.fakeCdp({
			"Runtime.evaluate": (params) => {
				const expression = String(params?.expression);
				try {
					const value = new Function("globalThis", `return ${expression};`)(g);
					return { result: { value } };
				} catch (error) {
					return { exceptionDetails: { text: String(error) } };
				}
			},
		});
	}
}

export const reactFixtures = new ReactFixtures();
