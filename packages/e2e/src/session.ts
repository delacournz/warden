/**
 * Process-wide session. The one session lives on `globalThis` under a `Symbol.for` key, not in a module-level `let`:
 * `preload.ts` (loaded by `bun test --preload`) and the spec files (which import `@delacour/warden-e2e`) can each load
 * their own copy of this module, and a module-level variable would give each copy its own session. The default
 * driver and fixture factories below are plain module state: they are wired by the package entry in the same copy
 * that reads them.
 */
import { mkdirSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { type DevtoolsFacet, type DevtoolsResult, devtoolsErrors } from "@delacour/warden-devtools/devtools.types";
import { devtoolsFacetOpener } from "@delacour/warden-devtools/facet";
import type { NativeLogDeps } from "@delacour/warden-devtools/native-log";
import type { Driver, DriverResult } from "@delacour/warden-driver/driver.types";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { observations } from "@delacour/warden-driver/observation-cache";
import { type SpanRunner, spans } from "@delacour/warden-driver/trace/span";
import { driverTracer } from "@delacour/warden-driver/traced-driver";
import { type HidRecoveryDeps, hidRecovery } from "@delacour/warden-driver-ios/hid-recovery";
import { type E2eEnv, envReader } from "./env";
import type { AttemptContext, FixtureFactory } from "./runner/fixtures.types";
import { type ResultsWriter, resultsFiles } from "./runner/results";
import { stepRunner } from "./runner/step";
import type { TraceWriter } from "./runner/trace";

/** A biometrics enroll right after a boot can be dropped: re-apply until the read-back shows enrolled. */
const ENROLL_TRIES = 5;
const ENROLL_RETRY_MS = 500;

export type DriverFactory = (env: E2eEnv) => DriverResult<Driver>;

/** How to attach to the app's dev client; default {@link SessionRegistry.openDevtools}. Tests inject a stub. */
export type DevtoolsOpener = (env: E2eEnv) => Promise<DevtoolsResult<DevtoolsFacet>>;

export type Session = {
	readonly env: E2eEnv;
	/** absolute `WARDEN_E2E_OUT` */
	readonly out: string;
	readonly results: ResultsWriter;
	/** builds `app`/`device`/`screen` for each attempt (T4/T6); settable so tests can fake it */
	fixtures: FixtureFactory | undefined;
	/** how a failed attempt's `native.log` / crash reports are read; absent in unit tests (nothing is spawned) */
	nativeLog: NativeLogDeps | undefined;
	/**
	 * Present for iOS runs with recovery wired: after a test failed with a lost HID connection, reboots the sim and
	 * reopens the driver and devtools, once per session. Resolves `true` when the test is worth running again.
	 */
	recoverHid: (() => Promise<boolean>) | undefined;
	/** closes the open driver and devtools so the next call opens them afresh (the device was rebooted under them) */
	resetDevice(): Promise<void>;
	/** where the console reporter prints one line; default fd 1 */
	readonly log: (line: string) => void;
	/** the running attempt, if any */
	readonly attempt: AttemptContext | undefined;
	/** aborts at the running attempt's deadline; never aborts outside an attempt. Pass it to every driver call and poll. */
	readonly signal: AbortSignal;
	/** the running attempt's artifacts dir and `trace.jsonl` (read at call time by the `app`/`device` fixtures) */
	readonly attemptDir: string | undefined;
	readonly trace: TraceWriter | undefined;
	/**
	 * opened on first call, then shared; a failed open is thrown as `E2eError{code:"DRIVER"}` and retried next call.
	 * Every call on it is a `driver.*` span in the running attempt's `trace.jsonl`, except a screen read that the
	 * observation cache answers from the snapshot a read just took (`driver/observation-cache.ts`; it offers `observe`).
	 */
	driver(): Promise<Driver>;
	/** the driver if it is already open; never opens one (failure capture must not start a device) */
	peekDriver(): Driver | undefined;
	/**
	 * The app's devtools (console, network, React tree, evaluate), attached on the first call and shared after;
	 * `devtools_unavailable` without `WARDEN_METRO_URL` (a release build). A failed attach is retried on the next call.
	 */
	devtools(): Promise<DevtoolsResult<DevtoolsFacet>>;
	/** the facet if it is already attached; never attaches one (failure capture must not connect to anything) */
	peekDevtools(): DevtoolsFacet | undefined;
	/** one reported step (`▸`/`▪` lines, `trace.jsonl`) that gives up when the attempt deadline aborts */
	step<T>(kind: string, label: string, fn: () => Promise<T>): Promise<T>;
	/** times one call as a `span` in the running attempt's `trace.jsonl` (no console line); just runs it outside an attempt */
	span: SpanRunner;
	/**
	 * Makes `attempt` the running one. With `replacing`, only when that is still the running one: an attempt's
	 * cleanup must not take the slot back from the next test that bun already started.
	 */
	enterAttempt(attempt: AttemptContext, replacing?: AttemptContext): void;
	/** Clears the running attempt; with `attempt`, only when that is the running one (never another test's). */
	leaveAttempt(attempt?: AttemptContext): void;
	/** idempotent; closes the driver only if it was opened */
	close(): Promise<void>;
};

export type SessionOptions = {
	/** parsed env; default `envReader.read(process.env)` (throws `SESSION` when not under warden) */
	env?: E2eEnv;
	/** how to open the device; default {@link SessionRegistry.setDefaultDriverFactory}'s */
	driverFactory?: DriverFactory;
	/** how to attach devtools; default {@link SessionRegistry.openDevtools} */
	devtools?: DevtoolsOpener;
	/** native log reader; default {@link SessionRegistry.setDefaultNativeLog}'s */
	nativeLog?: NativeLogDeps;
	/** sim reboot seams; default {@link SessionRegistry.setDefaultHidRecovery}'s */
	hidRecovery?: HidRecoveryDeps;
	/** fixture factory; default {@link SessionRegistry.setDefaultFixtureFactory}'s */
	fixtures?: FixtureFactory;
	/** console line sink; default writes to fd 1 (bun test captures `process.stdout`, fd 1 is not captured) */
	log?: (line: string) => void;
	/** close from `process.on("exit")`; default true */
	exitHook?: boolean;
};

const SESSION_KEY = Symbol.for("@delacour/warden-e2e/session");
type SessionSlot = { [SESSION_KEY]?: Session };

const WARM_TRIES = 15;
const WARM_INTERVAL_MS = 2_000;

/** The defaults a session takes when its options carry none; wired by the preload / package entry. */
type SessionDefaults = {
	driverFactory: DriverFactory | undefined;
	fixtures: FixtureFactory | undefined;
	nativeLog: NativeLogDeps | undefined;
	hidRecovery: HidRecoveryDeps | undefined;
};

type ProcessSessionDeps = {
	env: E2eEnv;
	factory: DriverFactory;
	fixtures: FixtureFactory | undefined;
	nativeLog: NativeLogDeps | undefined;
	hid: HidRecoveryDeps | undefined;
	openFacet: DevtoolsOpener;
	log: (line: string) => void;
	exitHook: boolean;
	/** called once the session has closed, so the registry can forget it */
	onClosed: (session: Session) => void;
};

/** One spec process's session: the lazily opened driver and devtools facet, the running attempt, HID recovery. */
class ProcessSession implements Session {
	readonly env: E2eEnv;
	readonly out: string;
	readonly results: ResultsWriter;
	fixtures: FixtureFactory | undefined;
	readonly nativeLog: NativeLogDeps | undefined;
	readonly recoverHid: (() => Promise<boolean>) | undefined;
	readonly log: (line: string) => void;

	private readonly idle = new AbortController().signal;
	private opened: Promise<Driver> | undefined;
	private current: Driver | undefined;
	private closing: Promise<void> | undefined;
	private devtoolsOpening: Promise<DevtoolsResult<DevtoolsFacet>> | undefined;
	private facet: DevtoolsFacet | undefined;
	private running: AttemptContext | undefined;
	private hidRecovered = false;
	private readonly exitListener: (() => void) | undefined;

	constructor(private readonly deps: ProcessSessionDeps) {
		this.env = deps.env;
		this.out = resolve(deps.env.out);
		mkdirSync(this.out, { recursive: true });
		this.results = resultsFiles.open(resolve(this.out, "results.jsonl"));
		this.fixtures = deps.fixtures;
		this.nativeLog = deps.nativeLog;
		this.log = deps.log;
		this.recoverHid =
			deps.hid === undefined || deps.env.platform !== "ios" ? undefined : () => this.recoverFromHidLoss();
		this.exitListener = deps.exitHook
			? () => {
					// `exit` handlers are synchronous: the best we can do is start the close
					void this.close();
				}
			: undefined;
		if (this.exitListener !== undefined) process.on("exit", this.exitListener);
	}

	get attempt(): AttemptContext | undefined {
		return this.running;
	}

	get signal(): AbortSignal {
		return this.running?.signal ?? this.idle;
	}

	get attemptDir(): string | undefined {
		return this.running?.dir;
	}

	get trace(): TraceWriter | undefined {
		return this.running?.trace;
	}

	/** The sleep the HID seams carry, else a timer. */
	private sleeper(): (ms: number) => Promise<void> {
		return this.deps.hid?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	}

	private note(line: string): void {
		this.deps.log(line);
	}

	async resetDevice(): Promise<void> {
		const driver = this.opened;
		this.opened = undefined;
		this.current = undefined;
		await driver?.then(
			(d) => d.close(),
			() => undefined
		);
		const attaching = this.devtoolsOpening;
		this.devtoolsOpening = undefined;
		this.facet = undefined;
		await attaching?.then(
			(result) => (result.success ? result.data.close() : undefined),
			() => undefined
		);
	}

	/**
	 * A freshly booted sim answers the first accessibility reads with `E_AX_UNAVAILABLE` until the in-sim bridge binds
	 * (what `warden e2e`'s warm step waits out): snapshot until one succeeds, a few times, then carry on regardless.
	 */
	private async warmBridge(): Promise<void> {
		const sleep = this.sleeper();
		for (let tries = 0; tries < WARM_TRIES; tries += 1) {
			try {
				const driver = await this.driver();
				if ((await driver.snapshot()).success) return;
			} catch {
				// not up yet: try again
			}
			await sleep(WARM_INTERVAL_MS);
		}
	}

	/** A physical iPhone: restart its runner host once. The phone is never rebooted and `simctl` is never run. */
	private async recoverRunner(deps: HidRecoveryDeps, name: string): Promise<boolean> {
		if (this.hidRecovered) {
			this.note(`iPhone ${name}: the runner connection was lost again after a restart; check the phone and retry`);
			return false;
		}
		this.hidRecovered = true;
		await this.resetDevice();
		const restarted = await hidRecovery.restartRunnerHost(deps, this.env.iosRunnerRestart, this.env.udid);
		if (!restarted.success) {
			this.note(`iPhone ${name}: runner connection lost, restart failed: ${restarted.error}`);
			return false;
		}
		this.note(`iPhone ${name}: runner connection lost, runner host restarted; running the test again`);
		return true;
	}

	/** Only the device `warden e2e` leased (this session's `WARDEN_UDID`), only once: a second loss fails as before. */
	private async recoverFromHidLoss(): Promise<boolean> {
		const hid = this.deps.hid;
		if (hid === undefined || this.closing !== undefined) return false;
		const env = this.env;
		const name = env.deviceName ?? env.udid;
		if (env.deviceKind === "physical") return this.recoverRunner(hid, name);
		if (this.hidRecovered) {
			this.note(`sim ${name}: HID connection lost again after a reboot; \`warden release <id> --shutdown\` and retry`);
			return false;
		}
		this.hidRecovered = true;
		await this.resetDevice();
		if (env.simdSocket !== undefined) {
			const stopped = await hidRecovery.stopResidentHelper(hid, env.simdSocket);
			if (!stopped.success) this.note(`sim ${name}: ${stopped.error}`);
		}
		const rebooted = await hidRecovery.rebootSim(hid, env.udid);
		if (!rebooted.success) {
			this.note(
				`sim ${name}: HID connection lost, reboot failed: ${rebooted.error}; \`warden release <id> --shutdown\` and retry`
			);
			return false;
		}
		await hidRecovery.runAfterReboot({ ...hid, log: (line) => this.note(line) }, env.afterReboot, env.udid);
		await this.warmBridge();
		this.note(`sim ${name}: HID connection lost (Device Hub quit?), rebooted; running the test again`);
		return true;
	}

	/**
	 * A biometrics iOS sim is enrolled again when the session opens, before any app install: a reused booted sim
	 * is left unenrolled by a spec that called `unenroll`. Best effort and idempotent; Android keeps its enrollment
	 * in the golden snapshot. A physical iPhone is never enrolled: its Face ID / Touch ID is the real sensor.
	 */
	private async reenroll(driver: Driver): Promise<Driver> {
		const env = this.env;
		if (env.biometrics !== true || env.platform !== "ios" || env.deviceKind === "physical") return driver;
		const sleep = this.sleeper();
		for (let attempt = 1; attempt <= ENROLL_TRIES; attempt += 1) {
			const state = await driver.biometrics("enroll");
			if (!state.success) {
				this.note(`biometrics enroll failed: ${state.error.code}: ${state.error.message}`);
				return driver;
			}
			if (state.data.enrolled) return driver;
			if (attempt < ENROLL_TRIES) await sleep(ENROLL_RETRY_MS);
		}
		this.note(`biometrics enroll did not take after ${ENROLL_TRIES} attempts`);
		return driver;
	}

	driver(): Promise<Driver> {
		if (this.closing !== undefined) {
			return Promise.reject(new E2eError("SESSION", "session is closed"));
		}
		this.opened ??= this.deps.factory(this.env).then(
			(result) => {
				if (!result.success) {
					this.opened = undefined;
					const { code, message } = result.error;
					throw new E2eError("DRIVER", `${code}: ${message}`);
				}
				this.current = observations.cache(driverTracer.trace(result.data, { trace: () => this.running?.trace }));
				return this.reenroll(this.current);
			},
			(cause: unknown) => {
				this.opened = undefined;
				throw new E2eError("DRIVER", cause instanceof Error ? cause.message : String(cause));
			}
		);
		return this.opened;
	}

	peekDriver(): Driver | undefined {
		return this.current;
	}

	devtools(): Promise<DevtoolsResult<DevtoolsFacet>> {
		if (this.closing !== undefined)
			return Promise.resolve(devtoolsErrors.err("devtools_unavailable", "session is closed"));
		if (this.env.metroUrl === undefined) {
			return Promise.resolve(
				devtoolsErrors.err("devtools_unavailable", "no Metro URL (WARDEN_METRO_URL): release builds have no devtools")
			);
		}
		if (this.devtoolsOpening !== undefined) return this.devtoolsOpening;
		const opening: Promise<DevtoolsResult<DevtoolsFacet>> = this.deps.openFacet(this.env).then(
			(result) => {
				if (!result.success) {
					if (this.devtoolsOpening === opening) this.devtoolsOpening = undefined;
					return result;
				}
				this.watchFacet(result.data, opening);
				return result;
			},
			(cause: unknown) => {
				if (this.devtoolsOpening === opening) this.devtoolsOpening = undefined;
				return devtoolsErrors.err("devtools_unavailable", cause instanceof Error ? cause.message : String(cause));
			}
		);
		this.devtoolsOpening = opening;
		return opening;
	}

	/**
	 * A facet that gave up reconnecting (an app relaunch outlasted its budget) is dropped, so the next call attaches
	 * again and failure capture never writes a dead facet's rings.
	 */
	private watchFacet(opened: DevtoolsFacet, opening: Promise<DevtoolsResult<DevtoolsFacet>>): void {
		this.facet = opened;
		opened.on("lost", () => {
			if (this.facet !== opened) return;
			this.facet = undefined;
			if (this.devtoolsOpening === opening) this.devtoolsOpening = undefined;
			opened.close();
		});
	}

	peekDevtools(): DevtoolsFacet | undefined {
		return this.facet;
	}

	step<T>(kind: string, label: string, fn: () => Promise<T>): Promise<T> {
		return stepRunner.run(this.running, kind, label, fn);
	}

	span: SpanRunner = (op, fn, options) => spans.run(this.running?.trace, op, fn, options);

	enterAttempt(next: AttemptContext, replacing?: AttemptContext): void {
		if (replacing !== undefined && this.running !== replacing) return;
		this.running = next;
	}

	leaveAttempt(leaving?: AttemptContext): void {
		if (leaving !== undefined && this.running !== leaving) return;
		this.running = undefined;
	}

	close(): Promise<void> {
		this.closing ??= this.shutDown();
		return this.closing;
	}

	private async shutDown(): Promise<void> {
		if (this.opened !== undefined) {
			await this.opened.then(
				(d) => d.close(),
				() => undefined
			);
		}
		this.current = undefined;
		if (this.devtoolsOpening !== undefined) {
			await this.devtoolsOpening.then(
				(result) => (result.success ? result.data.close() : undefined),
				() => undefined
			);
		}
		this.facet = undefined;
		this.deps.onClosed(this);
		if (this.exitListener !== undefined) process.off("exit", this.exitListener);
	}
}

/** Which context one attempt's own fixtures use right now; `finished` once the runner is done with the attempt. */
export type AttemptBinding = { readonly context: AttemptContext; readonly finished: boolean };

/**
 * `session` as one attempt's fixtures see it: `signal`, `attempt`, `attemptDir`, `trace`, `step` and `span` follow
 * `binding` (that attempt's run context, then its cleanup context, then an aborted one), never whichever attempt is
 * running when a call is made. So work the runner gave up on (a timed-out body that swallowed its `TIMEOUT`, an
 * `afterEach` past its limit) fails its next driver call instead of tapping into the next test. Everything else is
 * the shared session.
 */
class AttemptSession implements Session {
	constructor(
		private readonly shared: Session,
		private readonly binding: () => AttemptBinding
	) {}

	private context(): AttemptContext {
		return this.binding().context;
	}

	get env(): E2eEnv {
		return this.shared.env;
	}

	get out(): string {
		return this.shared.out;
	}

	get results(): ResultsWriter {
		return this.shared.results;
	}

	get nativeLog(): NativeLogDeps | undefined {
		return this.shared.nativeLog;
	}

	get recoverHid(): (() => Promise<boolean>) | undefined {
		return this.shared.recoverHid;
	}

	get fixtures(): FixtureFactory | undefined {
		return this.shared.fixtures;
	}

	set fixtures(factory: FixtureFactory | undefined) {
		this.shared.fixtures = factory;
	}

	get log(): (line: string) => void {
		return this.shared.log;
	}

	get attempt(): AttemptContext | undefined {
		return this.binding().finished ? undefined : this.context();
	}

	get signal(): AbortSignal {
		return this.context().signal;
	}

	get attemptDir(): string | undefined {
		return this.context().dir;
	}

	get trace(): TraceWriter | undefined {
		return this.binding().finished ? undefined : this.context().trace;
	}

	resetDevice(): Promise<void> {
		return this.shared.resetDevice();
	}

	driver(): Promise<Driver> {
		return this.shared.driver();
	}

	peekDriver(): Driver | undefined {
		return this.shared.peekDriver();
	}

	devtools(): Promise<DevtoolsResult<DevtoolsFacet>> {
		return this.shared.devtools();
	}

	peekDevtools(): DevtoolsFacet | undefined {
		return this.shared.peekDevtools();
	}

	step<T>(kind: string, label: string, fn: () => Promise<T>): Promise<T> {
		return stepRunner.run(this.context(), kind, label, fn);
	}

	span: SpanRunner = (op, fn, options) => spans.run(this.trace, op, fn, options);

	enterAttempt(next: AttemptContext, replacing?: AttemptContext): void {
		this.shared.enterAttempt(next, replacing);
	}

	leaveAttempt(leaving?: AttemptContext): void {
		this.shared.leaveAttempt(leaving);
	}

	close(): Promise<void> {
		return this.shared.close();
	}
}

/**
 * Whether a `.only` was collected. Kept on `globalThis` (with the session) because `preload.ts` checks it after
 * collection, and the preload and the spec files can load separate copies of the runner modules (a module-level
 * flag would always read false in the preload).
 */
const ONLY_KEY = Symbol.for("@delacour/warden-e2e/only");
type OnlySlot = { [ONLY_KEY]?: boolean };

/** The `.only` flag shared across module copies; see {@link onlyFlag}. */
export class OnlyFlag {
	/** Records that a `.only` was collected. */
	mark(): void {
		(globalThis as OnlySlot)[ONLY_KEY] = true;
	}

	wasSeen(): boolean {
		return (globalThis as OnlySlot)[ONLY_KEY] === true;
	}

	reset(): void {
		delete (globalThis as OnlySlot)[ONLY_KEY];
	}
}

export const onlyFlag = new OnlyFlag();

/**
 * Creates sessions and keeps the process-wide one on `globalThis`. The default driver and fixture factories are
 * plain instance state: they are wired by the package entry in the same copy that reads them.
 */
export class SessionRegistry {
	private defaults: SessionDefaults = {
		driverFactory: undefined,
		fixtures: undefined,
		nativeLog: undefined,
		hidRecovery: undefined,
	};

	private slot(): SessionSlot {
		return globalThis as SessionSlot;
	}

	/**
	 * Which inspector page is this env's: the bundle id and the device name. Several devices can share one Metro;
	 * without the name the newest page of any device would win and a reload or evaluate would hit another device's app.
	 */
	devtoolsTarget(env: E2eEnv): { appId: string; deviceName?: string } {
		return { appId: env.bundleId, ...(env.deviceName === undefined ? {} : { deviceName: env.deviceName }) };
	}

	/**
	 * Metro's inspector for this env's app (`WARDEN_METRO_URL`), pinned by {@link devtoolsTarget}. LogBox is kept off:
	 * its toasts and inspector cover the app and take taps, while the logs still reach the console capture.
	 */
	openDevtools: DevtoolsOpener = (env) =>
		devtoolsFacetOpener.open({
			env: { metroUrl: env.metroUrl },
			device: this.devtoolsTarget(env),
			fetch,
			WebSocket,
			timeoutMs: 5_000,
			log: (line) => process.stderr.write(`[devtools] ${line}\n`),
			muteLogBox: true,
		});

	/** Wires the HID-loss recovery used when a session gets none (`preload.ts` registers the real one). */
	setDefaultHidRecovery(deps: HidRecoveryDeps | undefined): void {
		this.defaults.hidRecovery = deps;
	}

	/** Wires the native-log reader used when a session gets none (`preload.ts` registers the real one). */
	setDefaultNativeLog(deps: NativeLogDeps | undefined): void {
		this.defaults.nativeLog = deps;
	}

	/** Wires the factory used when `get` gets none (`driver/open.ts`'s opener, set by the package entry). */
	setDefaultDriverFactory(factory: DriverFactory | undefined): void {
		this.defaults.driverFactory = factory;
	}

	/** Whether a default driver factory is wired (so the preload leaves a test-installed fake alone). */
	hasDefaultDriverFactory(): boolean {
		return this.defaults.driverFactory !== undefined;
	}

	/** Wires the `app`/`device`/`screen` factory used when `get` gets none. */
	setDefaultFixtureFactory(factory: FixtureFactory | undefined): void {
		this.defaults.fixtures = factory;
	}

	/** Whether a default fixture factory is wired (so the preload leaves a test-installed one alone). */
	hasDefaultFixtureFactory(): boolean {
		return this.defaults.fixtures !== undefined;
	}

	private missingFactory: DriverFactory = async () => ({
		success: false,
		error: {
			code: "E_INTERNAL",
			message: "no driver factory configured (setDefaultDriverFactory was never called)",
			retryable: false,
		},
	});

	private writeLine(line: string): void {
		try {
			writeSync(1, `${line}\n`);
		} catch {
			// a closed stdout must not fail a test
		}
	}

	private resolveEnv(env: E2eEnv | undefined): E2eEnv {
		if (env !== undefined) return env;
		const read = envReader.read(process.env);
		if (!read.success) throw new E2eError("SESSION", `invalid warden e2e environment:\n${read.error}`);
		if (read.data === undefined) throw new E2eError("SESSION", "not running under warden: WARDEN_UDID is not set");
		return read.data;
	}

	create(opts: SessionOptions = {}): Session {
		const session = new ProcessSession({
			env: this.resolveEnv(opts.env),
			factory: opts.driverFactory ?? this.defaults.driverFactory ?? this.missingFactory,
			fixtures: opts.fixtures ?? this.defaults.fixtures,
			nativeLog: opts.nativeLog ?? this.defaults.nativeLog,
			hid: opts.hidRecovery ?? this.defaults.hidRecovery,
			openFacet: opts.devtools ?? this.openDevtools,
			log: opts.log ?? ((line) => this.writeLine(line)),
			exitHook: opts.exitHook !== false,
			onClosed: (closed) => {
				if (this.slot()[SESSION_KEY] === closed) delete this.slot()[SESSION_KEY];
			},
		});
		return session;
	}

	/** `session` as one attempt's fixtures see it; see {@link AttemptSession}. */
	forAttempt(session: Session, binding: () => AttemptBinding): Session {
		return new AttemptSession(session, binding);
	}

	/** The process-wide session (`globalThis[Symbol.for("@delacour/warden-e2e/session")]`), created on first call. */
	get(opts: SessionOptions = {}): Session {
		const existing = this.slot()[SESSION_KEY];
		if (existing !== undefined) return existing;
		const session = this.create(opts);
		this.slot()[SESSION_KEY] = session;
		return session;
	}

	/** Closes and forgets the process-wide session, if any. */
	async reset(): Promise<void> {
		await this.slot()[SESSION_KEY]?.close();
		delete this.slot()[SESSION_KEY];
	}
}

export const sessions = new SessionRegistry();
