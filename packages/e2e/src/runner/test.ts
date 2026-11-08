import { afterAll as bunAfterAll, beforeAll as bunBeforeAll, describe as bunDescribe, test as bunTest } from "bun:test";
import type { Platform } from "../driver/driver.types";
import { missingRequirements, type Requirement } from "../driver/requirements";
import { E2eError } from "../errors";
import { getSession } from "../session";
import { buildBaseFixtures, type FixtureEntry, type FixtureSetup, runAttempt, runnerTiming } from "./attempt";
import { callerFile } from "./callsite";
import { type BaseFixtures, SYSTEM_ALERTS } from "./fixtures.types";
import {
	createScope,
	currentScope,
	type Hook,
	markOnly,
	ownHook,
	registrationDefaults,
	resolveUse,
	runInScope,
	type Scope,
	type UseOptions,
} from "./scope";

export type TestOptions = {
	/** ms for the whole attempt (hooks included); beats `test.use({ timeout })` */
	timeout?: number;
	skip?: boolean;
	only?: boolean;
	/** run only on these platforms (decided at collection time from `WARDEN_PLATFORM`) */
	platforms?: readonly Platform[];
	/**
	 * driver capabilities the test needs (`pinch`, `multiTouch`). The test is skipped, when collected, on a device whose
	 * driver is known to lack one: a physical iPhone has neither. Elsewhere the driver decides at run time.
	 */
	requires?: readonly Requirement[];
	/** extra attempts after a failure; only the last attempt writes to `results.jsonl` */
	retry?: number;
};

export type TestBody<F extends object> = (fixtures: F) => void | Promise<void>;

export type TestCallable<F extends object> = {
	(title: string, body: TestBody<F>): void;
	(title: string, options: TestOptions, body: TestBody<F>): void;
};

/**
 * `test.extend` fixtures: set up, call `use(value)`, clean up afterwards (runs even when the test
 * failed). A fixture may read the ones defined before it in the same object (`base`).
 */
export type FixtureDefs<Base extends object, Extra extends object> = {
	[K in keyof Extra]: (base: Base & Extra, use: (value: Extra[K]) => Promise<void>) => Promise<void>;
};

export type TestApi<F extends object> = TestCallable<F> & {
	skip: TestCallable<F>;
	only: TestCallable<F>;
	/** a placeholder that never passes silently: it fails if bun is run with `--todo` */
	todo(title: string): void;
	skipIf(condition: boolean): TestCallable<F>;
	/** applies to every test collected in the current scope (file or `describe`) */
	use(options: UseOptions): void;
	/**
	 * Like the top-level `beforeEach`, typed with this `test`'s fixtures (the ones `extend` added too). It runs only
	 * for tests made with this `test` or one extended from it, not for the base `test`'s.
	 */
	beforeEach(hook: (fixtures: F) => void | Promise<void>): void;
	/** `beforeEach`'s counterpart: runs after each such test, even when it failed. */
	afterEach(hook: (fixtures: F) => void | Promise<void>): void;
	/** a `test` whose bodies also receive `Extra` */
	extend<Extra extends object>(defs: FixtureDefs<F, Extra>): TestApi<F & Extra>;
};

type Mode = "run" | "skip" | "only";

/** Scopes (and their ancestors) that already hold a registered test: bun fixed those tests' timeouts then. */
const registered = new WeakSet<Scope>();

function markRegistered(scope: Scope): void {
	for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) registered.add(s);
}

function registerTest<F extends object>(
	fixtures: readonly FixtureEntry[],
	mode: Mode,
	title: string,
	second: TestOptions | TestBody<F>,
	third?: TestBody<F>
): void {
	const options = typeof second === "function" ? {} : second;
	const body = typeof second === "function" ? second : third;
	if (body === undefined) {
		throw new E2eError("INVALID_ARGUMENT", `test("${title}"): the test body is missing`);
	}
	const scope: Scope = currentScope();
	const file = callerFile();
	const path = [...scope.title, title];
	const defaults = registrationDefaults();
	const use = resolveUse(scope, defaults, options.timeout);
	const retry = options.retry ?? 0;

	const wrongPlatform =
		options.platforms !== undefined &&
		defaults.platform !== undefined &&
		!options.platforms.includes(defaults.platform);
	const lacking =
		missingRequirements({ platform: defaults.platform, deviceKind: defaults.deviceKind }, options.requires).length > 0;
	const only = mode === "only" || options.only === true;
	if (only) markOnly();

	markRegistered(scope);
	const bunTimeoutMs = use.timeoutMs + runnerTiming().bunMarginMs;
	let attempts = 0;
	const run = async (): Promise<void> => {
		attempts += 1;
		await runAttempt<F>(getSession(), {
			file,
			title: path,
			scope,
			fixtures,
			body,
			...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
			only,
			final: attempts > retry,
			bunTimeoutMs,
		});
	};
	const bunOptions = { timeout: bunTimeoutMs, retry };

	if (mode === "skip" || options.skip === true || wrongPlatform || lacking) bunTest.skip(title, run, bunOptions);
	else if (only) bunTest.only(title, run, bunOptions);
	else bunTest(title, run, bunOptions);
}

/**
 * A typed `test.extend` fixture as the untyped {@link FixtureSetup} the attempt runner stores. The runner builds the
 * bag from the earlier fixtures in definition order, so `base` has the shape the caller's `setup` declared; `use`
 * widens for free (it only ever receives that fixture's own value).
 */
function eraseSetup<Base extends object, Value>(
	setup: (base: Base, use: (value: Value) => Promise<void>) => Promise<void>
): FixtureSetup {
	return (base, use) => setup(base as Base, use);
}

/** A hook typed with a test's fixtures as the scope's {@link Hook}; the runner only calls it for tests that have them. */
function eraseHook<F extends object>(hook: (fixtures: F) => void | Promise<void>): Hook {
	return (fixtures) => hook(fixtures as unknown as F);
}

function isKeyOf<T extends object>(object: T, key: PropertyKey): key is keyof T {
	return key in object;
}

function makeCallable<F extends object>(fixtures: readonly FixtureEntry[], mode: Mode): TestCallable<F> {
	return (title: string, second: TestOptions | TestBody<F>, third?: TestBody<F>): void =>
		registerTest<F>(fixtures, mode, title, second, third);
}

function makeTest<F extends object>(fixtures: readonly FixtureEntry[]): TestApi<F> {
	const base = makeCallable<F>(fixtures, "run");
	return Object.assign(base, {
		skip: makeCallable<F>(fixtures, "skip"),
		only: makeCallable<F>(fixtures, "only"),
		todo(title: string): void {
			bunTest.todo(title, () => {
				throw new E2eError("INVALID_ARGUMENT", `test.todo("${title}") is not implemented`);
			});
		},
		skipIf(condition: boolean): TestCallable<F> {
			return makeCallable<F>(fixtures, condition ? "skip" : "run");
		},
		beforeEach(hook: (fixtures: F) => void | Promise<void>): void {
			currentScope().beforeEach.push(ownHook(eraseHook(hook), fixtures));
		},
		afterEach(hook: (fixtures: F) => void | Promise<void>): void {
			currentScope().afterEach.push(ownHook(eraseHook(hook), fixtures));
		},
		use(options: UseOptions): void {
			if (options.systemAlerts !== undefined && !SYSTEM_ALERTS.includes(options.systemAlerts)) {
				throw new E2eError(
					"INVALID_ARGUMENT",
					`test.use: systemAlerts must be one of ${SYSTEM_ALERTS.map((mode) => `"${mode}"`).join(", ")}, got ${JSON.stringify(options.systemAlerts)}`
				);
			}
			const scope = currentScope();
			if (options.timeout !== undefined && registered.has(scope)) {
				process.stderr.write(
					`warden: test.use({ timeout: ${options.timeout} }) comes after a test in the same scope; bun fixed that ` +
						"test's own timeout when it was registered, so put test.use above the tests it is for\n"
				);
			}
			scope.use = { ...scope.use, ...options };
		},
		extend<Extra extends object>(defs: FixtureDefs<F, Extra>): TestApi<F & Extra> {
			const added: FixtureEntry[] = [];
			for (const name of Object.keys(defs)) {
				if (isKeyOf(defs, name)) added.push({ name, setup: eraseSetup<F & Extra, Extra[keyof Extra]>(defs[name]) });
			}
			return makeTest<F & Extra>([...fixtures, ...added]);
		},
	});
}

/** The spec `test`. Fixtures: `{ app, device, screen, platform }`. */
export const test: TestApi<BaseFixtures> = makeTest<BaseFixtures>([]);

export type DescribeOptions = {
	/** accepted for API parity: bun runs a file's tests one after another unless `--concurrent` */
	serial?: boolean;
};

export function describe(title: string, body: () => void): void;
export function describe(title: string, options: DescribeOptions, body: () => void): void;
export function describe(title: string, second: DescribeOptions | (() => void), third?: () => void): void {
	const body = typeof second === "function" ? second : third;
	const options = typeof second === "function" ? {} : second;
	if (body === undefined) throw new E2eError("INVALID_ARGUMENT", `describe("${title}"): the body is missing`);
	const scope = createScope(title, options.serial === true);
	bunDescribe(title, () => runInScope(scope, body));
}

/** Runs before every test in this scope, outermost scope first; receives the test's `{ app, device, screen, platform }`. */
export function beforeEach(hook: Hook): void {
	currentScope().beforeEach.push(hook);
}

/** Runs after every test in this scope, innermost scope first, even when the test failed. */
export function afterEach(hook: Hook): void {
	currentScope().afterEach.push(hook);
}

async function sharedFixtures(scope: Scope): Promise<BaseFixtures> {
	const session = getSession();
	const defaults = session.env;
	const use = resolveUse(scope, {
		timeoutMs: defaults.timeoutMs,
		actionTimeoutMs: defaults.actionTimeoutMs,
		assertionTimeoutMs: defaults.assertionTimeoutMs,
	});
	return buildBaseFixtures(session, session.signal, use);
}

/** Once per file/`describe`, before its first test; receives the base fixtures (not the `extend` ones). */
export function beforeAll(hook: Hook): void {
	const scope = currentScope();
	bunBeforeAll(async () => hook(await sharedFixtures(scope)));
}

/** Once per file/`describe`, after its last test. */
export function afterAll(hook: Hook): void {
	const scope = currentScope();
	bunAfterAll(async () => hook(await sharedFixtures(scope)));
}
