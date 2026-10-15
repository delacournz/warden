import { readdirSync } from "node:fs";
import { join } from "node:path";
import { E2eError } from "../errors";
import type { Session } from "../session";
import { attemptDir, flowIdOf, hash6 } from "./artifacts";
import { captureFailure } from "./failure";
import type { AttemptContext, BaseFixtures } from "./fixtures.types";
import type { TestResult } from "./results";
import { hooksFor, type ResolvedUse, resolveUse, type Scope } from "./scope";
import { formatConsoleLine, openTrace, shortName } from "./trace";

/** Longest one hook or fixture teardown may take once the test itself is over. */
export const CLEANUP_TIMEOUT_MS = 10_000;

type Bag = BaseFixtures & Record<string, unknown>;

/** `test.extend` fixture: set up, `use(value)`, and everything after `use` is the teardown. */
export type FixtureSetup = (base: Record<string, unknown>, use: (value: unknown) => Promise<void>) => Promise<void>;
export type FixtureEntry = { name: string; setup: FixtureSetup };

export type AttemptSpec<F extends object> = {
	/** absolute path of the spec file */
	file: string;
	/** describe titles, then the test title */
	title: readonly string[];
	scope: Scope;
	fixtures: readonly FixtureEntry[];
	body: (fixtures: F) => void | Promise<void>;
	/** per-test `timeout` option (beats `test.use`) */
	timeout?: number;
	only: boolean;
	/** no retries left: only a final (or passing) attempt appends to `results.jsonl` */
	final: boolean;
};

/** A stand-in that throws a clear `SESSION` error on first use instead of failing at construction. */
function unavailable<T extends object>(name: string): T {
	return new Proxy({} as T, {
		get(_target, prop) {
			if (typeof prop === "symbol" || prop === "then") return undefined;
			throw new E2eError(
				"SESSION",
				`the \`${name}\` fixture is not available: no fixture factory is registered on the session`
			);
		},
	});
}

/** `app`/`device`/`screen`/`platform` from the session's factory (throwing stand-ins when none is registered). */
export async function buildBaseFixtures(
	session: Session,
	signal: AbortSignal,
	use: ResolvedUse
): Promise<BaseFixtures> {
	if (session.fixtures === undefined) {
		return {
			app: unavailable("app"),
			device: unavailable("device"),
			screen: unavailable("screen"),
			platform: session.env.platform,
		};
	}
	return session.fixtures({
		session,
		signal,
		launch: use.launch,
		actionTimeoutMs: use.actionTimeoutMs,
		assertionTimeoutMs: use.assertionTimeoutMs,
	});
}

type StartedFixture = { value: unknown; teardown: () => Promise<void> };

/** Runs `setup` up to its `use(value)` call; `teardown()` resumes it and waits for it to finish. */
async function startFixture(entry: FixtureEntry, bag: Record<string, unknown>): Promise<StartedFixture> {
	let provide: (value: unknown) => void = () => undefined;
	let fail: (error: unknown) => void = () => undefined;
	let release: () => void = () => undefined;
	let used = false;
	const value = new Promise<unknown>((resolve, reject) => {
		provide = resolve;
		fail = reject;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const finished = entry
		.setup(bag, async (v) => {
			used = true;
			provide(v);
			await released;
		})
		.then(
			() => {
				if (!used) fail(new E2eError("INVALID_ARGUMENT", `fixture \`${entry.name}\` finished without calling use()`));
			},
			(error: unknown) => {
				if (!used) fail(error);
				else throw error;
			}
		);
	// a setup failure surfaces through `value`; a teardown failure through `teardown()`
	finished.catch(() => undefined);
	const resolved = await value;
	return {
		value: resolved,
		teardown: async () => {
			release();
			await finished;
		},
	};
}

function limited<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new E2eError("TIMEOUT", `${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer));
}

/** `screenshots/NNN-name.png` files `device.screenshot()` wrote during the attempt, relative to `dir`. */
function listScreenshots(dir: string): string[] {
	try {
		return readdirSync(join(dir, "screenshots")).map((name) => `screenshots/${name}`);
	} catch {
		return [];
	}
}

function errorInfo(error: unknown): NonNullable<TestResult["error"]> {
	if (error instanceof Error) {
		return {
			message: error.message,
			...(error instanceof E2eError ? { code: error.code } : {}),
			...(error.stack !== undefined ? { stack: error.stack } : {}),
		};
	}
	return { message: String(error) };
}

/**
 * One attempt of one test: deadline (`AbortSignal`), fixtures, `beforeEach`, body, then — whatever
 * happened — failure capture, `afterEach`, fixture teardown (reverse order), the `■` line and the
 * `results.jsonl` line. Throws the test's own error so bun marks the test failed.
 */
export async function runAttempt<F extends object>(session: Session, spec: AttemptSpec<F>): Promise<void> {
	const { env } = session;
	const use = resolveUse(
		spec.scope,
		{ timeoutMs: env.timeoutMs, actionTimeoutMs: env.actionTimeoutMs, assertionTimeoutMs: env.assertionTimeoutMs },
		spec.timeout
	);
	const startedAt = Date.now();
	const device = { udid: env.udid, platform: env.platform };
	const clock = !env.logTimestamps;
	const short = shortName(spec.file);
	const dir = attemptDir(session.out, flowIdOf(spec.file, env.flowsDir), spec.title, hash6(spec.file, ...spec.title));
	const print = (line: string | undefined): void => {
		if (line !== undefined) session.log(line);
	};

	const files = new Set<string>();
	const trace = openTrace(join(dir, "trace.jsonl"), (event) => {
		files.add("trace.jsonl");
		print(formatConsoleLine(event, { clock, short, depth: session.attempt?.depth ?? 0 }));
	});
	const controller = new AbortController();
	const ctx: AttemptContext = {
		signal: controller.signal,
		dir,
		short,
		trace,
		depth: 0,
		files,
	};

	print(
		formatConsoleLine(
			{ type: "test-start", test: { file: spec.file, title: [...spec.title], startedAt, device } },
			{ clock }
		)
	);
	session.enterAttempt(ctx);

	let deadlineHit = false;
	const timer = setTimeout(() => {
		deadlineHit = true;
		controller.abort(new E2eError("TIMEOUT", `test timed out after ${use.timeoutMs}ms`));
	}, use.timeoutMs);
	const deadline = new Promise<never>((_, reject) => {
		controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
	});
	deadline.catch(() => undefined);

	const teardowns: Array<{ name: string; run: () => Promise<void> }> = [];
	const state: { bag?: Bag } = {};
	let failed = false;
	let failure: unknown;

	try {
		await Promise.race([setUpAndRun(session, spec, use, controller.signal, state, teardowns), deadline]);
	} catch (error) {
		failed = true;
		failure = error;
	} finally {
		clearTimeout(timer);
	}

	if (failed) await captureFailureArtifacts(session, ctx);

	const cleanupErrors = await runCleanup(session, spec, ctx, state.bag, teardowns);
	if (!controller.signal.aborted) controller.abort(new E2eError("SESSION", "attempt finished"));
	session.leaveAttempt();

	if (!failed && cleanupErrors.length > 0) {
		failed = true;
		failure = cleanupErrors[0];
	}

	for (const shot of listScreenshots(dir)) files.add(shot);
	const outcome: Outcome = failed ? { failed: true, error: failure, timedOut: deadlineHit } : { failed: false };
	const result = buildResult(spec, ctx, { startedAt, device }, outcome);
	print(formatConsoleLine({ type: "test-end", result }, { clock }));
	if (!failed || spec.final) session.results.append(result);

	if (failed) throw failure instanceof Error ? failure : new Error(String(failure));
}

type Outcome = { failed: false } | { failed: true; error: unknown; timedOut: boolean };

function buildResult<F extends object>(
	spec: AttemptSpec<F>,
	ctx: AttemptContext,
	run: { startedAt: number; device: TestResult["device"] },
	outcome: Outcome
): TestResult {
	const status: TestResult["status"] = !outcome.failed ? "passed" : outcome.timedOut ? "timed-out" : "failed";
	return {
		file: spec.file,
		title: [...spec.title],
		status,
		durationMs: Date.now() - run.startedAt,
		startedAt: run.startedAt,
		...(spec.only ? { only: true } : {}),
		...(outcome.failed ? { error: errorInfo(outcome.error) } : {}),
		...(ctx.files.size > 0 ? { artifacts: { dir: ctx.dir, files: [...ctx.files].sort() } } : {}),
		device: run.device,
	};
}

/**
 * Base fixtures, the runner's `app.open()` (`launch: "fresh"`), `test.extend` fixtures in definition
 * order, `beforeEach` hooks (outermost first), then the body. Records the bag and each teardown as
 * soon as it exists so cleanup sees a partial setup.
 */
async function setUpAndRun<F extends object>(
	session: Session,
	spec: AttemptSpec<F>,
	use: ResolvedUse,
	signal: AbortSignal,
	state: { bag?: Bag },
	teardowns: Array<{ name: string; run: () => Promise<void> }>
): Promise<void> {
	const base = await buildBaseFixtures(session, signal, use);
	const built: Bag = { ...base };
	state.bag = built;
	if (use.launch === "fresh") await session.step("app", "app.open", () => base.app.open());
	for (const entry of spec.fixtures) {
		const started = await session.step("fixture", entry.name, () => startFixture(entry, built));
		built[entry.name] = started.value;
		teardowns.push({ name: entry.name, run: started.teardown });
	}
	for (const hook of hooksFor(spec.scope, "beforeEach")) {
		await session.step("hook", "beforeEach", async () => hook(built));
	}
	// the one unchecked step of `test.extend`: its fixtures are typed `F`, built from the entries above
	await spec.body(built as unknown as F);
}

/** `failure.png` + `screen-at-failure.txt` from the already-open driver (never opens one); problems go to the trace. */
async function captureFailureArtifacts(session: Session, ctx: AttemptContext): Promise<void> {
	const driver = session.peekDriver();
	if (driver === undefined) return;
	const capture = await captureFailure(driver, ctx.dir);
	for (const file of capture.files) ctx.files.add(file);
	for (const problem of capture.problems) {
		ctx.trace.write({ type: "note", ts: Date.now(), kind: "note", label: `failure capture: ${problem}` });
	}
}

/**
 * `afterEach` hooks (innermost scope first) then fixture teardowns (reverse order), each limited to
 * {@link CLEANUP_TIMEOUT_MS} and run under a fresh signal: the test's own may already be aborted.
 * Returns every error instead of throwing, so one failing hook never skips the rest.
 */
async function runCleanup<F extends object>(
	session: Session,
	spec: AttemptSpec<F>,
	ctx: AttemptContext,
	built: Bag | undefined,
	teardowns: ReadonlyArray<{ name: string; run: () => Promise<void> }>
): Promise<unknown[]> {
	const cleanup = new AbortController();
	session.enterAttempt({ ...ctx, signal: cleanup.signal, depth: 0 });
	const errors: unknown[] = [];
	const attempt = async (label: string, fn: () => Promise<void>): Promise<void> => {
		try {
			await limited(label, CLEANUP_TIMEOUT_MS, fn);
		} catch (error) {
			errors.push(error);
		}
	};
	if (built !== undefined) {
		for (const hook of hooksFor(spec.scope, "afterEach")) {
			await attempt("afterEach", () => session.step("hook", "afterEach", async () => hook(built)));
		}
	}
	for (const fixture of [...teardowns].reverse()) {
		await attempt(`fixture ${fixture.name} teardown`, () =>
			session.step("fixture", `${fixture.name} teardown`, fixture.run)
		);
	}
	cleanup.abort(new E2eError("SESSION", "attempt finished"));
	return errors;
}
