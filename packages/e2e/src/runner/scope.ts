/**
 * Collection-time scopes (file roots, `describe` blocks, `test.use`). `ScopeRegistry` keeps `roots` and `stack`, filled and
 * read while one spec file is collected. The `.only` flag is the exception: it lives on `globalThis`, which only `session.ts` touches
 * (`markOnly`, `onlyWasSeen`, `resetOnly` there).
 */
import { DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_ASSERTION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, envReader } from "../env";
import { callSite } from "./callsite";
import type { BaseFixtures, LaunchMode, SystemAlerts } from "./fixtures.types";

/** Headroom over the test timeout so warden's `AbortSignal` deadline fires before bun's own. */
export const BUN_TIMEOUT_MARGIN_MS = 30_000;

export type UseOptions = {
	timeout?: number;
	actionTimeout?: number;
	assertionTimeout?: number;
	launch?: LaunchMode;
	/**
	 * Answer an alert or sheet over the app whenever a read or wait sees one (it already has the snapshot, so a screen
	 * without one costs nothing): `dismiss` presses what `device.alert("dismiss")` would, `accept` what `("accept")`
	 * would, `off` (default) leaves it. It also answers the app's own alerts, so a test that taps those buttons
	 * itself keeps it `off`.
	 */
	systemAlerts?: SystemAlerts;
};

export type ResolvedUse = {
	timeoutMs: number;
	actionTimeoutMs: number;
	assertionTimeoutMs: number;
	launch: LaunchMode;
	systemAlerts: SystemAlerts;
};

/** Scope hooks are stored against the base fixtures; `test.extend(...).beforeEach` hooks are narrowed back to theirs by the runner (bun's own hooks take no arguments). */
export type Hook = (fixtures: BaseFixtures) => void | Promise<void>;

export type Scope = {
	/** describe titles from the root down to this scope */
	readonly title: readonly string[];
	readonly parent: Scope | undefined;
	use: UseOptions;
	readonly beforeEach: Hook[];
	readonly afterEach: Hook[];
	/** accepted for API parity: bun runs a file's tests serially unless `--concurrent` */
	readonly serial: boolean;
};

export type ScopeDeps = {
	/** the spec file making the current call */
	callerFile: () => string;
};

/**
 * One root per spec file: `bun test a.e2e.ts b.e2e.ts` shares this module, but `test.use` and root hooks must not
 * cross files.
 */
export class ScopeRegistry {
	/** Fixture sets that own a hook (`test.extend(...).beforeEach`): it runs only for tests whose fixtures start with the owner's. */
	private readonly hookOwners = new WeakMap<Hook, readonly object[]>();
	private readonly roots = new Map<string, Scope>();
	private readonly stack: Scope[] = [];

	constructor(private readonly deps: ScopeDeps) {}

	/** Marks `hook` as belonging to tests built from `fixtures` (entries compared by identity, in definition order). */
	ownHook(hook: Hook, fixtures: readonly object[]): Hook {
		if (fixtures.length > 0) this.hookOwners.set(hook, fixtures);
		return hook;
	}

	/** The innermost `describe` being collected, else the root scope of the spec file making the call. */
	currentScope(): Scope {
		return this.stack[this.stack.length - 1] ?? this.rootFor(this.deps.callerFile());
	}

	/**
	 * The scope of a `describe` call. Created when `describe()` is called — its parent is whatever is
	 * current then — because bun runs the callback later (nested ones after the parent's callback has
	 * returned), when the stack no longer says where it belongs.
	 */
	createScope(title: string, serial: boolean): Scope {
		const parent = this.currentScope();
		return this.newScope([...parent.title, title], parent, serial);
	}

	/** Runs `body` (bun's `describe` callback) with `scope` current. */
	runInScope(scope: Scope, body: () => void): void {
		this.stack.push(scope);
		try {
			body();
		} finally {
			this.stack.pop();
		}
	}

	/** Root first, `scope` last. */
	scopeChain(scope: Scope): Scope[] {
		const chain: Scope[] = [];
		for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) chain.unshift(s);
		return chain;
	}

	/** `beforeEach`: outermost first. `afterEach`: innermost first. Hooks owned by another fixture set are left out. */
	hooksFor(scope: Scope, kind: "beforeEach" | "afterEach", fixtures: readonly object[] = []): Hook[] {
		const chain = this.scopeChain(scope);
		if (kind === "afterEach") chain.reverse();
		return chain
			.flatMap((s) => s[kind])
			.filter((hook) => {
				const owner = this.hookOwners.get(hook);
				return owner === undefined || owner.every((entry, i) => fixtures[i] === entry);
			});
	}

	/** Session defaults (env contract) under the nearest `test.use`, under the test's own `timeout`. */
	resolveUse(
		scope: Scope,
		defaults: Pick<ResolvedUse, "timeoutMs" | "actionTimeoutMs" | "assertionTimeoutMs">,
		testTimeout?: number
	): ResolvedUse {
		const resolved: ResolvedUse = { ...defaults, launch: "fresh", systemAlerts: "off" };
		for (const s of this.scopeChain(scope)) {
			if (s.use.timeout !== undefined) resolved.timeoutMs = s.use.timeout;
			if (s.use.actionTimeout !== undefined) resolved.actionTimeoutMs = s.use.actionTimeout;
			if (s.use.assertionTimeout !== undefined) resolved.assertionTimeoutMs = s.use.assertionTimeout;
			if (s.use.launch !== undefined) resolved.launch = s.use.launch;
			if (s.use.systemAlerts !== undefined) resolved.systemAlerts = s.use.systemAlerts;
		}
		if (testTimeout !== undefined) resolved.timeoutMs = testTimeout;
		return resolved;
	}

	/** Timeouts known at collection time: the env when set, else the contract defaults. */
	registrationDefaults(env: Readonly<Record<string, string | undefined>> = process.env) {
		const read = envReader.read(env);
		const parsed = read.success ? read.data : undefined;
		return {
			timeoutMs: parsed?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			actionTimeoutMs: parsed?.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
			assertionTimeoutMs: parsed?.assertionTimeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS,
			platform: parsed?.platform,
			deviceKind: parsed?.deviceKind,
		};
	}

	private newScope(title: readonly string[], parent: Scope | undefined, serial: boolean): Scope {
		return { title, parent, use: {}, beforeEach: [], afterEach: [], serial };
	}

	private rootFor(file: string): Scope {
		let root = this.roots.get(file);
		if (root === undefined) {
			root = this.newScope([], undefined, false);
			this.roots.set(file, root);
		}
		return root;
	}
}

export const scopes = new ScopeRegistry({ callerFile: () => callSite.callerFile() });
