import { describe, expect, test } from "bun:test";
import { E2eError } from "../errors";
import {
	createScope,
	currentScope,
	hooksFor,
	markOnly,
	onlyWasSeen,
	ownHook,
	registrationDefaults,
	resetOnly,
	resolveUse,
	runInScope,
	scopeChain,
} from "./scope";
import { test as specTest } from "./test";

const defaults = { timeoutMs: 120_000, actionTimeoutMs: 30_000, assertionTimeoutMs: 5_000 };

describe("scopes", () => {
	test("a child is created under whatever is current, and nests while its body runs", () => {
		const root = currentScope();
		const outer = createScope("outer", false);
		expect(outer.parent).toBe(root);
		expect(outer.title).toEqual(["outer"]);

		let seen: string[] = [];
		runInScope(outer, () => {
			expect(currentScope()).toBe(outer);
			const inner = createScope("inner", true);
			seen = [...inner.title];
			expect(inner.parent).toBe(outer);
			expect(inner.serial).toBe(true);
		});
		expect(seen).toEqual(["outer", "inner"]);
		expect(currentScope()).toBe(root);
	});

	test("a scope keeps its parent even when its body runs after the parent's has returned", () => {
		const outer = createScope("deferred-outer", false);
		let inner: ReturnType<typeof createScope> | undefined;
		runInScope(outer, () => {
			inner = createScope("deferred-inner", false);
		});
		// bun runs the inner callback later, with only the inner scope pushed
		runInScope(inner ?? outer, () => {
			expect(scopeChain(currentScope()).map((s) => s.title.at(-1))).toEqual([
				undefined,
				"deferred-outer",
				"deferred-inner",
			]);
		});
	});

	test("hooks: beforeEach outermost first, afterEach innermost first", () => {
		const outer = createScope("hooks-outer", false);
		const inner = createScope("hooks-inner", false);
		const order: string[] = [];
		const mark = (name: string) => () => {
			order.push(name);
		};
		outer.beforeEach.push(mark("be-outer"));
		inner.beforeEach.push(mark("be-inner"));
		outer.afterEach.push(mark("ae-outer"));
		inner.afterEach.push(mark("ae-inner"));
		// `inner` was created while root was current; rebuild the real chain explicitly
		let child: typeof inner | undefined;
		runInScope(outer, () => {
			child = createScope("hooks-child", false);
		});
		child?.beforeEach.push(mark("be-child"));
		child?.afterEach.push(mark("ae-child"));
		const fixtures = { app: {}, device: {}, screen: {}, platform: "ios" } as never;
		for (const hook of hooksFor(child ?? outer, "beforeEach")) hook(fixtures);
		for (const hook of hooksFor(child ?? outer, "afterEach")) hook(fixtures);
		expect(order).toEqual(["be-outer", "be-child", "ae-child", "ae-outer"]);
	});
});

describe("hooks owned by a fixture set", () => {
	test("run only for tests whose fixtures start with the owner's", () => {
		const scope = createScope("owned-hooks", false);
		const a = {};
		const b = {};
		const ran: string[] = [];
		const mark = (name: string) => () => {
			ran.push(name);
		};
		scope.beforeEach.push(mark("all"));
		scope.beforeEach.push(ownHook(mark("a"), [a]));
		scope.beforeEach.push(ownHook(mark("a+b"), [a, b]));
		const names = (fixtures: readonly object[]) => {
			ran.length = 0;
			for (const hook of hooksFor(scope, "beforeEach", fixtures)) hook({} as never);
			return [...ran];
		};
		expect(names([])).toEqual(["all"]);
		expect(names([a])).toEqual(["all", "a"]);
		expect(names([a, b])).toEqual(["all", "a", "a+b"]);
		expect(names([b])).toEqual(["all"]);
	});
});

describe("resolveUse", () => {
	test("env defaults, overridden outer to inner, then by the test's own timeout", () => {
		const outer = createScope("use-outer", false);
		let inner: ReturnType<typeof createScope> | undefined;
		runInScope(outer, () => {
			inner = createScope("use-inner", false);
		});
		expect(resolveUse(outer, defaults)).toEqual({ ...defaults, launch: "fresh", systemAlerts: "off" });

		outer.use = { timeout: 1000, actionTimeout: 2000, launch: "none", systemAlerts: "dismiss" };
		if (inner) inner.use = { timeout: 3000, assertionTimeout: 40, systemAlerts: "accept" };
		expect(resolveUse(inner ?? outer, defaults)).toEqual({
			timeoutMs: 3000,
			actionTimeoutMs: 2000,
			assertionTimeoutMs: 40,
			launch: "none",
			systemAlerts: "accept",
		});
		expect(resolveUse(inner ?? outer, defaults, 99).timeoutMs).toBe(99);
	});

	test("systemAlerts is off unless a scope says otherwise, and the nearest scope wins", () => {
		const outer = createScope("alerts-outer", false);
		let inner: ReturnType<typeof createScope> | undefined;
		runInScope(outer, () => {
			inner = createScope("alerts-inner", false);
		});
		expect(resolveUse(inner ?? outer, defaults).systemAlerts).toBe("off");
		outer.use = { systemAlerts: "dismiss" };
		expect(resolveUse(inner ?? outer, defaults).systemAlerts).toBe("dismiss");
		if (inner) inner.use = { systemAlerts: "off" };
		expect(resolveUse(inner ?? outer, defaults).systemAlerts).toBe("off");
		expect(resolveUse(outer, defaults).systemAlerts).toBe("dismiss");
	});
});

describe("test.use systemAlerts", () => {
	test("takes dismiss, accept or off and refuses anything else", () => {
		expect(() => specTest.use({ systemAlerts: "maybe" as never })).toThrow(E2eError);
		expect(() => specTest.use({ systemAlerts: true as never })).toThrow(/systemAlerts/);
	});
});

describe("registrationDefaults", () => {
	test("contract defaults without env, env values with it", () => {
		expect(registrationDefaults({})).toEqual({
			timeoutMs: 120_000,
			actionTimeoutMs: 30_000,
			assertionTimeoutMs: 5_000,
			platform: undefined,
		});
		const env = { WARDEN_UDID: "U", WARDEN_BUNDLE_ID: "b", WARDEN_PLATFORM: "android", WARDEN_E2E_TIMEOUT: "777" };
		expect(registrationDefaults(env)).toMatchObject({ timeoutMs: 777, platform: "android" });
	});

	test("an invalid env falls back to the defaults (the session reports it)", () => {
		expect(registrationDefaults({ WARDEN_UDID: "U" }).timeoutMs).toBe(120_000);
	});
});

describe("only flag", () => {
	test("is process-wide until reset", () => {
		resetOnly();
		expect(onlyWasSeen()).toBe(false);
		markOnly();
		expect(onlyWasSeen()).toBe(true);
		resetOnly();
		expect(onlyWasSeen()).toBe(false);
	});
});
