import { readdirSync } from "node:fs";
import { join } from "node:path";
import { attemptDir, hash6, specIdOf } from "@delacour/warden-device/artifacts";
import { conditionsOf } from "@delacour/warden-device/conditions/device-conditions";
import { perfStartFor } from "@delacour/warden-device/perf/device-perf";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { hidRecovery } from "@delacour/warden-driver-ios/hid-recovery";
import { type AttemptBinding, type Session, sessions } from "../session";
import { CAPTURE_TIMEOUT_MS, failureArtifacts } from "./failure";
import type { AttemptContext, BaseFixtures } from "./fixtures.types";
import type { TestResult } from "./results";
import { BUN_TIMEOUT_MARGIN_MS, type ResolvedUse, type Scope, scopes } from "./scope";
import { stepRunner } from "./step";
import { consoleLines, traceFile } from "./trace";

/** Longest one hook or fixture teardown may take once the test itself is over. */
export const CLEANUP_TIMEOUT_MS = 10_000;

/** Part of bun's margin the runner never spends after a deadline: the `■` line and the results line still need it. */
export const POST_DEADLINE_RESERVE_MS = 5_000;

/** The runner's own time limits around a test body (see {@link AttemptRunner.setRunnerTiming}). */
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

/** One thing to undo after the test; `when` false = nothing to undo, so no step line and no cleanup budget spent. */
type Teardown = { name: string; run: () => Promise<void>; when?: () => boolean };

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

type StartedFixture = { value: unknown; teardown: () => Promise<void> };

type BodyOutcome = { failed: boolean; failure: unknown; deadlineHit: boolean };

type Outcome = { failed: false } | { failed: true; error: unknown; timedOut: boolean };

/**
 * Runs one attempt of one test. `timing` is the runner's own set of limits; the shared `attemptRunner` holds the one
 * a runner fixture spec shrinks.
 */
export class AttemptRunner {
	private timing: RunnerTiming = { ...DEFAULT_TIMING };

	runnerTiming(): Readonly<RunnerTiming> {
		return this.timing;
	}

	/**
	 * Test seam: a runner fixture spec shrinks the limits (before it registers its tests) so a slow-cleanup case runs
	 * in milliseconds. `undefined` restores the defaults.
	 */
	setRunnerTiming(next: Partial<RunnerTiming> | undefined): void {
		this.timing = next === undefined ? { ...DEFAULT_TIMING } : { ...this.timing, ...next };
	}

	/** `app`/`device`/`screen`/`platform` from the session's factory (throwing stand-ins when none is registered). */
	async buildBaseFixtures(session: Session, signal: AbortSignal, use: ResolvedUse): Promise<BaseFixtures> {
		if (session.fixtures === undefined) {
			return {
				app: this.unavailable("app"),
				device: this.unavailable("device"),
				screen: this.unavailable("screen"),
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

	/**
	 * When the runner must be done with an attempt: bun's own timeout for the test (or the resolved timeout plus bun's
	 * margin, if that is sooner) minus the reserve. Failure capture, `afterEach` hooks and fixture teardowns all spend
	 * from this one budget, so bun never gives up on a test (and starts the next one) while its cleanup still runs.
	 */
	cleanupDeadline(startedAt: number, timeoutMs: number, bunTimeoutMs: number | undefined): number {
		const t = this.runnerTiming();
		return startedAt + Math.min(timeoutMs + t.bunMarginMs, bunTimeoutMs ?? Number.POSITIVE_INFINITY) - t.reserveMs;
	}

	/**
	 * One attempt of one test: deadline (`AbortSignal`), fixtures, `beforeEach`, body, then — whatever
	 * happened — failure capture, `afterEach`, fixture teardown (reverse order), the `■` line and the
	 * `results.jsonl` line. Throws the test's own error so bun marks the test failed.
	 */
	async run<F extends object>(session: Session, spec: AttemptSpec<F>): Promise<void> {
		if ((await this.runOnce(session, spec)) === "again") await this.runOnce(session, { ...spec });
	}

	/** One error for every `expect.soft` failure of the attempt. */
	softFailureError(failures: readonly E2eError[]): E2eError {
		if (failures.length === 1 && failures[0] !== undefined) return failures[0];
		const body = failures.map((failure, index) => `${index + 1}) ${failure.message}`).join("\n\n");
		return new E2eError("ASSERTION", `${failures.length} soft assertions failed:\n\n${body}`, failures[0]?.screen);
	}

	/** A stand-in that throws a clear `SESSION` error on first use instead of failing at construction. */
	private unavailable<T extends object>(name: string): T {
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

	/** Runs `setup` up to its `use(value)` call; `teardown()` resumes it and waits for it to finish. */
	private async startFixture(entry: FixtureEntry, bag: Record<string, unknown>): Promise<StartedFixture> {
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

	private limited<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new E2eError("TIMEOUT", `${label} timed out after ${ms}ms`)), ms);
		});
		return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer));
	}

	/** `screenshots/NNN-name.png` files `device.screenshot()` wrote during the attempt, relative to `dir`. */
	private listScreenshots(dir: string): string[] {
		try {
			return readdirSync(join(dir, "screenshots")).map((name) => `screenshots/${name}`);
		} catch {
			return [];
		}
	}

	private errorInfo(error: unknown): NonNullable<TestResult["error"]> {
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
	 * The whole attempt is the unit that is run again after a lost HID connection (see `Session.recoverHid`), not the
	 * failed tap: the reboot killed the app and everything the test had set up, so only a fresh `app.open()` and the
	 * test from its first line is sound. The first run's failure is printed but not recorded in `results.jsonl`.
	 */
	private async runOnce<F extends object>(session: Session, spec: AttemptSpec<F>): Promise<"again" | undefined> {
		const { env } = session;
		const use = scopes.resolveUse(
			spec.scope,
			{ timeoutMs: env.timeoutMs, actionTimeoutMs: env.actionTimeoutMs, assertionTimeoutMs: env.assertionTimeoutMs },
			spec.timeout
		);
		const startedAt = Date.now();
		const cleanupBy = this.cleanupDeadline(startedAt, use.timeoutMs, spec.bunTimeoutMs);
		const budget = (): number => cleanupBy - Date.now();
		const device = { udid: env.udid, platform: env.platform };
		const clock = !env.logTimestamps;
		const short = consoleLines.shortName(spec.file);
		const dir = attemptDir(session.out, specIdOf(spec.file, env.specsDir), spec.title, hash6(spec.file, ...spec.title));
		const print = (line: string | undefined): void => {
			if (line !== undefined) session.log(line);
		};

		const files = new Set<string>();
		// what this attempt's fixtures and steps run against: the run context, its cleanup context, then a finished one
		let binding: AttemptBinding | undefined;
		const trace = traceFile.open(join(dir, "trace.jsonl"), (event) => {
			files.add("trace.jsonl");
			print(consoleLines.format(event, { clock, short, depth: binding?.context.depth ?? 0 }));
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
		const bound = sessions.forAttempt(session, () => binding ?? { context: ctx, finished: false });

		print(
			consoleLines.format(
				{ type: "test-start", test: { file: spec.file, title: [...spec.title], startedAt, device } },
				{ clock }
			)
		);
		session.enterAttempt(ctx);

		const teardowns: Teardown[] = [];
		const state: { bag?: Bag } = {};
		let outcome = await this.raceDeadline(controller, use.timeoutMs, () =>
			this.setUpAndRun(bound, spec, use, controller.signal, state, teardowns)
		);
		outcome = this.failIf(outcome, ctx.softFailures.length > 0, () => this.softFailureError(ctx.softFailures));
		if (outcome.failed) await this.captureFailureArtifacts(session, ctx, budget, startedAt);

		const cleanupErrors = await this.runCleanup(session, spec, ctx, state.bag, teardowns, budget, (context) => {
			binding = { context, finished: false };
		});
		const finished = new E2eError("SESSION", "attempt finished");
		if (!controller.signal.aborted) controller.abort(finished);
		// anything of this attempt still running (a body that outlived its deadline, an afterEach past its limit) now
		// fails its next step or driver call instead of acting in the next test
		binding = { context: { ...ctx, signal: AbortSignal.abort(finished), depth: 0 }, finished: true };
		session.leaveAttempt(ctx);
		trace.flush();

		outcome = this.failIf(outcome, cleanupErrors.length > 0, () => cleanupErrors[0]);

		return this.concludeAttempt(session, spec, ctx, { startedAt, device }, outcome, print, clock);
	}

	/** Runs `run` against the test deadline: aborts `controller` when it passes, and reports how the body ended. */
	private async raceDeadline(
		controller: AbortController,
		timeoutMs: number,
		run: () => Promise<void>
	): Promise<BodyOutcome> {
		let deadlineHit = false;
		const timer = setTimeout(() => {
			deadlineHit = true;
			controller.abort(new E2eError("TIMEOUT", `test timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const deadline = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
		});
		deadline.catch(() => undefined);
		try {
			await Promise.race([run(), deadline]);
			return { failed: false, failure: undefined, deadlineHit };
		} catch (error) {
			return { failed: true, failure: error, deadlineHit };
		} finally {
			clearTimeout(timer);
		}
	}

	/** Turns a passing outcome into a failed one with `failure()` when `present`; a failure already there is kept. */
	private failIf(outcome: BodyOutcome, present: boolean, failure: () => unknown): BodyOutcome {
		return outcome.failed || !present ? outcome : { ...outcome, failed: true, failure: failure() };
	}

	/** Writes the result line, recovers from a lost HID connection, records the result and rethrows the test's error. */
	private async concludeAttempt<F extends object>(
		session: Session,
		spec: AttemptSpec<F>,
		ctx: AttemptContext,
		run: { startedAt: number; device: TestResult["device"] },
		outcome: BodyOutcome,
		print: (line: string | undefined) => void,
		clock: boolean
	): Promise<"again" | undefined> {
		for (const shot of this.listScreenshots(ctx.dir)) ctx.files.add(shot);
		const result = this.buildResult(
			spec,
			ctx,
			run,
			outcome.failed ? { failed: true, error: outcome.failure, timedOut: outcome.deadlineHit } : { failed: false }
		);
		print(consoleLines.format({ type: "test-end", result }, { clock }));
		if (
			outcome.failed &&
			session.recoverHid !== undefined &&
			hidRecovery.isRecoverableLoss(outcome.failure, session.env.deviceKind) &&
			(await session.recoverHid())
		) {
			return "again";
		}
		if (!outcome.failed || spec.final) session.results.append(result);

		if (outcome.failed) throw outcome.failure instanceof Error ? outcome.failure : new Error(String(outcome.failure));
		return undefined;
	}

	private buildResult<F extends object>(
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
			...(outcome.failed ? { error: this.errorInfo(outcome.error) } : {}),
			...(ctx.files.size > 0 ? { artifacts: { dir: ctx.dir, files: [...ctx.files].sort() } } : {}),
			device: run.device,
		};
	}

	/**
	 * Base fixtures, the runner's `app.open()` (`launch: "fresh"`), `test.extend` fixtures in definition
	 * order, `beforeEach` hooks (outermost first), then the body. Records the bag and each teardown as
	 * soon as it exists so cleanup sees a partial setup.
	 */
	private async setUpAndRun<F extends object>(
		session: Session,
		spec: AttemptSpec<F>,
		use: ResolvedUse,
		signal: AbortSignal,
		state: { bag?: Bag },
		teardowns: Teardown[]
	): Promise<void> {
		const base = await this.buildBaseFixtures(session, signal, use);
		const built: Bag = { ...base };
		state.bag = built;
		const perfNames = session.env.perf;
		if (perfNames !== undefined) {
			const { perf } = base.device;
			await session.step("perf", "perf.start", () => perf.start(perfStartFor(perfNames)));
			// the body may have stopped it (to pass its own budgets); then there is nothing left to end
			teardowns.push({
				name: "perf",
				run: async () => {
					if (perf.active) await perf.stop();
				},
			});
		}
		const conditions = conditionsOf(base.device);
		if (conditions !== undefined) {
			// registered before it is applied, so a half-applied baseline is still put back
			teardowns.push({ name: "conditions", run: () => conditions.teardown(), when: () => conditions.dirty() });
			if (conditions.declared)
				await session.step("conditions", "conditions.baseline", () => conditions.applyBaseline());
		}
		if (use.launch === "fresh") await session.step("app", "app.open", () => base.app.open());
		for (const entry of spec.fixtures) {
			const started = await session.step("fixture", entry.name, () => this.startFixture(entry, built));
			built[entry.name] = started.value;
			teardowns.push({ name: entry.name, run: started.teardown });
		}
		for (const hook of scopes.hooksFor(spec.scope, "beforeEach", spec.fixtures)) {
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
	private async captureFailureArtifacts(
		session: Session,
		ctx: AttemptContext,
		budget: () => number,
		startedAt: number
	): Promise<void> {
		const driver = session.peekDriver();
		const facet = session.peekDevtools();
		const { captureTimeoutMs } = this.runnerTiming();
		const captures = [
			...(driver === undefined
				? []
				: [await failureArtifacts.captureFailure(driver, ctx.dir, captureTimeoutMs, budget)]),
			...(facet === undefined
				? []
				: [await failureArtifacts.captureDevtoolsArtifacts(facet, ctx.dir, captureTimeoutMs, budget)]),
			...(session.nativeLog === undefined
				? []
				: [
						await failureArtifacts.captureNativeArtifacts(
							failureArtifacts.nativeTarget(session.env),
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
	private async runCleanup<F extends object>(
		session: Session,
		spec: AttemptSpec<F>,
		ctx: AttemptContext,
		built: Bag | undefined,
		teardowns: readonly Teardown[],
		budget: () => number,
		bind: (context: AttemptContext) => void
	): Promise<unknown[]> {
		const cleanup = new AbortController();
		const cleanupCtx: AttemptContext = { ...ctx, signal: cleanup.signal, depth: 0 };
		// only this attempt's own slot: bun may already have started the next test
		session.enterAttempt(cleanupCtx, ctx);
		bind(cleanupCtx);
		const step = <T>(kind: string, label: string, fn: () => Promise<T>): Promise<T> =>
			stepRunner.run(cleanupCtx, kind, label, fn);
		const errors: unknown[] = [];
		const attempt = async (label: string, fn: () => Promise<void>): Promise<void> => {
			try {
				const left = budget();
				if (left <= 0) throw new E2eError("TIMEOUT", `${label} skipped: the cleanup budget after the test is used up`);
				await this.limited(label, Math.min(this.timing.cleanupTimeoutMs, left), fn);
			} catch (error) {
				errors.push(error);
			}
		};
		if (built !== undefined) {
			for (const hook of scopes.hooksFor(spec.scope, "afterEach", spec.fixtures)) {
				await attempt("afterEach", () => step("hook", "afterEach", async () => hook(built)));
			}
		}
		for (const fixture of [...teardowns].reverse()) {
			if (fixture.when?.() === false) continue;
			await attempt(`fixture ${fixture.name} teardown`, () => step("fixture", `${fixture.name} teardown`, fixture.run));
		}
		cleanup.abort(new E2eError("SESSION", "attempt finished"));
		session.leaveAttempt(cleanupCtx);
		return errors;
	}
}

export const attemptRunner = new AttemptRunner();
