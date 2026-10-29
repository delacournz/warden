/**
 * Collection-time scopes (file roots, `describe` blocks, `test.use`). `roots` and `stack` are module state, filled and
 * read while one spec file is collected. The `.only` flag below is the exception: it lives on `globalThis` under a
 * `Symbol.for` key because `preload.ts` checks it after collection, and the preload and the spec files can load
 * separate copies of this module (a module-level flag would always read false in the preload).
 */
import { DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_ASSERTION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, readEnv } from "../env";
import { callerFile } from "./callsite";
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

/** Fixture sets that own a hook (`test.extend(...).beforeEach`): it runs only for tests whose fixtures start with the owner's. */
const hookOwners = new WeakMap<Hook, readonly object[]>();

/** Marks `hook` as belonging to tests built from `fixtures` (entries compared by identity, in definition order). */
export function ownHook(hook: Hook, fixtures: readonly object[]): Hook {
	if (fixtures.length > 0) hookOwners.set(hook, fixtures);
	return hook;
}

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

function newScope(title: readonly string[], parent: Scope | undefined, serial: boolean): Scope {
	return { title, parent, use: {}, beforeEach: [], afterEach: [], serial };
}

/** One root per spec file: `bun test a.e2e.ts b.e2e.ts` shares this module, but `test.use` and root hooks must not cross files. */
const roots = new Map<string, Scope>();
const stack: Scope[] = [];

function rootFor(file: string): Scope {
	let root = roots.get(file);
	if (root === undefined) {
		root = newScope([], undefined, false);
		roots.set(file, root);
	}
	return root;
}

/** The innermost `describe` being collected, else the root scope of the spec file making the call. */
export function currentScope(): Scope {
	return stack[stack.length - 1] ?? rootFor(callerFile());
}

/**
 * The scope of a `describe` call. Created when `describe()` is called — its parent is whatever is
 * current then — because bun runs the callback later (nested ones after the parent's callback has
 * returned), when the stack no longer says where it belongs.
 */
export function createScope(title: string, serial: boolean): Scope {
	const parent = currentScope();
	return newScope([...parent.title, title], parent, serial);
}

/** Runs `body` (bun's `describe` callback) with `scope` current. */
export function runInScope(scope: Scope, body: () => void): void {
	stack.push(scope);
	try {
		body();
	} finally {
		stack.pop();
	}
}

/** Root first, `scope` last. */
export function scopeChain(scope: Scope): Scope[] {
	const chain: Scope[] = [];
	for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) chain.unshift(s);
	return chain;
}

/** `beforeEach`: outermost first. `afterEach`: innermost first. Hooks owned by another fixture set are left out. */
export function hooksFor(scope: Scope, kind: "beforeEach" | "afterEach", fixtures: readonly object[] = []): Hook[] {
	const chain = scopeChain(scope);
	if (kind === "afterEach") chain.reverse();
	return chain
		.flatMap((s) => s[kind])
		.filter((hook) => {
			const owner = hookOwners.get(hook);
			return owner === undefined || owner.every((entry, i) => fixtures[i] === entry);
		});
}

/** Session defaults (env contract) under the nearest `test.use`, under the test's own `timeout`. */
export function resolveUse(
	scope: Scope,
	defaults: Pick<ResolvedUse, "timeoutMs" | "actionTimeoutMs" | "assertionTimeoutMs">,
	testTimeout?: number
): ResolvedUse {
	const resolved: ResolvedUse = { ...defaults, launch: "fresh", systemAlerts: "off" };
	for (const s of scopeChain(scope)) {
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
export function registrationDefaults(env: Readonly<Record<string, string | undefined>> = process.env) {
	const read = readEnv(env);
	const parsed = read.success ? read.data : undefined;
	return {
		timeoutMs: parsed?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		actionTimeoutMs: parsed?.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
		assertionTimeoutMs: parsed?.assertionTimeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS,
		platform: parsed?.platform,
		deviceKind: parsed?.deviceKind,
	};
}

const ONLY_KEY = Symbol.for("@delacour/warden-e2e/only");
type OnlySlot = { [ONLY_KEY]?: boolean };

/** Records that a `.only` was collected (kept on `globalThis`: the preload and the specs may be separate bundles). */
export function markOnly(): void {
	(globalThis as OnlySlot)[ONLY_KEY] = true;
}

export function onlyWasSeen(): boolean {
	return (globalThis as OnlySlot)[ONLY_KEY] === true;
}

export function resetOnly(): void {
	delete (globalThis as OnlySlot)[ONLY_KEY];
}
