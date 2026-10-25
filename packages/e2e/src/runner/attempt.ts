import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isHidLost } from "../driver/ios/hid-recovery";
import { E2eError } from "../errors";
import { type AttemptBinding, attemptSession, type Session } from "../session";
import { attemptDir, hash6, specIdOf } from "./artifacts";
import {
	CAPTURE_TIMEOUT_MS,
	captureDevtoolsArtifacts,
	captureFailure,
	captureNativeArtifacts,
	nativeTarget,
} from "./failure";
import type { AttemptContext, BaseFixtures } from "./fixtures.types";
import type { TestResult } from "./results";
import { BUN_TIMEOUT_MARGIN_MS, hooksFor, type ResolvedUse, resolveUse, type Scope } from "./scope";
import { runStep } from "./step";
import { formatConsoleLine, openTrace, shortName } from "./trace";

/** Longest one hook or fixture teardown may take once the test itself is over. */
export const CLEANUP_TIMEOUT_MS = 10_000;

/** Part of bun's margin the runner never spends after a deadline: the `■` line and the results line still need it. */
export const POST_DEADLINE_RESERVE_MS = 5_000;

/** The runner's own time limits around a test body (see {@link setRunnerTiming}). */
export type RunnerTiming = {
	/** longest one `afterEach` hook or fixture teardown may take ({@link CLEANUP_TIMEOUT_MS}) */
	cleanupTimeoutMs: number;
	/** longest one failure capture call may take (`CAPTURE_TIMEOUT_MS`) */
	captureTimeoutMs: number;
	/** what bun's own per-test timeout adds over warden's deadline (`BUN_TIMEOUT_MARGIN_MS`) */
	bunMarginMs: number;
	/** part of that margin left unspent ({@link POST_DEADLINE_RESERVE_MS}) */
	reserveMs: number;
};

const DEFAULT_TIMING: RunnerTiming = {
	cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
	captureTimeoutMs: CAPTURE_TIMEOUT_MS,
	bunMarginMs: BUN_TIMEOUT_MARGIN_MS,
	reserveMs: POST_DEADLINE_RESERVE_MS,
};

let timing: RunnerTiming = { ...DEFAULT_TIMING };

export function runnerTiming(): Readonly<RunnerTiming> {
	return timing;
}

/**
 * Test seam: a runner fixture spec shrinks the limits (before it registers its tests) so a slow-cleanup case runs
 * in milliseconds. `undefined` restores the defaults.
 */
export function setRunnerTiming(next: Partial<RunnerTiming> | undefined): void {
	timing = next === undefined ? { ...DEFAULT_TIMING } : { ...timing, ...next };
}

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
	/** bun's own timeout for this test, fixed when it was registered (default: the resolved timeout + bun's margin) */
	bunTimeoutMs?: number;
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
		systemAlerts: use.systemAlerts,
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

/**
 * When the runner must be done with an attempt: bun's own timeout for the test (or the resolved timeout plus bun's
 * margin, if that is sooner) minus the reserve. Failure capture, `afterEach` hooks and fixture teardowns all spend
 * from this one budget, so bun never gives up on a test (and starts the next one) while its cleanup still runs.
 */
export function cleanupDeadline(startedAt: number, timeoutMs: number, bunTimeoutMs: number | undefined): number {
	const t = runnerTiming();
	return startedAt + Math.min(timeoutMs + t.bunMarginMs, bunTimeoutMs ?? Number.POSITIVE_INFINITY) - t.reserveMs;
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
	if ((await runAttemptOnce(session, spec)) === "again") await runAttemptOnce(session, { ...spec });
}

/**
 * The whole attempt is the unit that is run again after a lost HID connection (see `Session.recoverHid`), not the
 * failed tap: the reboot killed the app and everything the test had set up, so only a fresh `app.open()` and the
 * test from its first line is sound. The first run's failure is printed but not recorded in `results.jsonl`.
 */
async function runAttemptOnce<F extends object>(session: Session, spec: AttemptSpec<F>): Promise<"again" | undefined> {
	const { env } = session;
	const use = resolveUse(
		spec.scope,
		{ timeoutMs: env.timeoutMs, actionTimeoutMs: env.actionTimeoutMs, assertionTimeoutMs: env.assertionTimeoutMs },
		spec.timeout
	);
	const startedAt = Date.now();
	const cleanupBy = cleanupDeadline(startedAt, use.timeoutMs, spec.bunTimeoutMs);
	const budget = (): number => cleanupBy - Date.now();
	const device = { udid: env.udid, platform: env.platform };
	const clock = !env.logTimestamps;
	const short = shortName(spec.file);
	const dir = attemptDir(session.out, specIdOf(spec.file, env.specsDir), spec.title, hash6(spec.file, ...spec.title));
	const print = (line: string | undefined): void => {
		if (line !== undefined) session.log(line);
	};

	const files = new Set<string>();
	// what this attempt's fixtures and steps run against: the run context, its cleanup context, then a finished one
	let binding: AttemptBinding | undefined;
	const trace = openTrace(join(dir, "trace.jsonl"), (event) => {
		files.add("trace.jsonl");
		print(formatConsoleLine(event, { clock, short, depth: binding?.context.depth ?? 0 }));
	});
	const controller = new AbortController();
	const ctx: AttemptContext = {
		signal: controller.signal,
		dir,
		short,
		trace,
		depth: 0,
		files,
		softFailures: [],
	};
	binding = { context: ctx, finished: false };
	const bound = attemptSession(session, () => binding ?? { context: ctx, finished: false });

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
		await Promise.race([setUpAndRun(bound, spec, use, controller.signal, state, teardowns), deadline]);
	} catch (error) {
		failed = true;
		failure = error;
	} finally {
		clearTimeout(timer);
	}

	if (!failed && ctx.softFailures.length > 0) {
		failed = true;
		failure = softFailureError(ctx.softFailures);
	}
	if (failed) await captureFailureArtifacts(session, ctx, budget, startedAt);

	const cleanupErrors = await runCleanup(session, spec, ctx, state.bag, teardowns, budget, (context) => {
		binding = { context, finished: false };
	});
	const finished = new E2eError("SESSION", "attempt finished");
	if (!controller.signal.aborted) controller.abort(finished);
	// anything of this attempt still running (a body that outlived its deadline, an afterEach past its limit) now
	// fails its next step or driver call instead of acting in the next test
	binding = { context: { ...ctx, signal: AbortSignal.abort(finished), depth: 0 }, finished: true };
	session.leaveAttempt(ctx);
	trace.flush();

	if (!failed && cleanupErrors.length > 0) {
		failed = true;
		failure = cleanupErrors[0];
	}

	for (const shot of listScreenshots(dir)) files.add(shot);
	const outcome: Outcome = failed ? { failed: true, error: failure, timedOut: deadlineHit } : { failed: false };
	const result = buildResult(spec, ctx, { startedAt, device }, outcome);
	print(formatConsoleLine({ type: "test-end", result }, { clock }));
	if (failed && session.recoverHid !== undefined && isHidLost(failure) && (await session.recoverHid())) {
		return "again";
	}
	if (!failed || spec.final) session.results.append(result);

	if (failed) throw failure instanceof Error ? failure : new Error(String(failure));
	return undefined;
}

/** One error for every `expect.soft` failure of the attempt. */
export function softFailureError(failures: readonly E2eError[]): E2eError {
	if (failures.length === 1 && failures[0] !== undefined) return failures[0];
	const body = failures.map((failure, index) => `${index + 1}) ${failure.message}`).join("\n\n");
	return new E2eError("ASSERTION", `${failures.length} soft assertions failed:\n\n${body}`, failures[0]?.screen);
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
	for (const hook of hooksFor(spec.scope, "beforeEach", spec.fixtures)) {
		await session.step("hook", "beforeEach", async () => hook(built));
	}
	// the one unchecked step of `test.extend`: its fixtures are typed `F`, built from the entries above
	await spec.body(built as unknown as F);
}

/**
 * `failure.png` + `screen-at-failure.txt` from the already-open driver and `console.jsonl` + `network.jsonl` from the
 * already-attached devtools (never opens either), plus `native.log` and iOS crash reports of the app; problems go
 * to the trace.
 */
async function captureFailureArtifacts(
	session: Session,
	ctx: AttemptContext,
	budget: () => number,
	startedAt: number
): Promise<void> {
	const driver = session.peekDriver();
	const facet = session.peekDevtools();
	const { captureTimeoutMs } = runnerTiming();
	const captures = [
		...(driver === undefined ? [] : [await captureFailure(driver, ctx.dir, captureTimeoutMs, budget)]),
		...(facet === undefined ? [] : [await captureDevtoolsArtifacts(facet, ctx.dir, captureTimeoutMs, budget)]),
		...(session.nativeLog === undefined
			? []
			: [
					await captureNativeArtifacts(
						nativeTarget(session.env),
						session.nativeLog,
						{ dir: ctx.dir, sinceMs: startedAt },
						captureTimeoutMs,
						budget
					),
				]),
	];
	for (const capture of captures) {
		for (const file of capture.files) ctx.files.add(file);
		for (const problem of capture.problems) {
			ctx.trace.write({ type: "note", ts: Date.now(), kind: "note", label: `failure capture: ${problem}` });
		}
	}
}

/**
 * `afterEach` hooks (innermost scope first) then fixture teardowns (reverse order), each limited to
 * {@link CLEANUP_TIMEOUT_MS} or what is left of the attempt's budget, whichever is less, and run under a fresh
 * signal: the test's own may already be aborted. Once the budget is spent the rest are skipped, each with a
 * `TIMEOUT` error. Returns every error instead of throwing, so one failing hook never skips the rest.
 */
async function runCleanup<F extends object>(
	session: Session,
	spec: AttemptSpec<F>,
	ctx: AttemptContext,
	built: Bag | undefined,
	teardowns: ReadonlyArray<{ name: string; run: () => Promise<void> }>,
	budget: () => number,
	bind: (context: AttemptContext) => void
): Promise<unknown[]> {
	const cleanup = new AbortController();
	const cleanupCtx: AttemptContext = { ...ctx, signal: cleanup.signal, depth: 0 };
	// only this attempt's own slot: bun may already have started the next test
	session.enterAttempt(cleanupCtx, ctx);
	bind(cleanupCtx);
	const step = <T>(kind: string, label: string, fn: () => Promise<T>): Promise<T> =>
		runStep(cleanupCtx, kind, label, fn);
	const errors: unknown[] = [];
	const attempt = async (label: string, fn: () => Promise<void>): Promise<void> => {
		try {
			const left = budget();
			if (left <= 0) throw new E2eError("TIMEOUT", `${label} skipped: the cleanup budget after the test is used up`);
			await limited(label, Math.min(timing.cleanupTimeoutMs, left), fn);
		} catch (error) {
			errors.push(error);
		}
	};
	if (built !== undefined) {
		for (const hook of hooksFor(spec.scope, "afterEach", spec.fixtures)) {
			await attempt("afterEach", () => step("hook", "afterEach", async () => hook(built)));
		}
	}
	for (const fixture of [...teardowns].reverse()) {
		await attempt(`fixture ${fixture.name} teardown`, () => step("fixture", `${fixture.name} teardown`, fixture.run));
	}
	cleanup.abort(new E2eError("SESSION", "attempt finished"));
	session.leaveAttempt(cleanupCtx);
	return errors;
}
