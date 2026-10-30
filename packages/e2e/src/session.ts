/**
 * Process-wide session. The one session lives on `globalThis` under a `Symbol.for` key, not in a module-level `let`:
 * `preload.ts` (loaded by `bun test --preload`) and the spec files (which import `@delacour/warden-e2e`) can each load
 * their own copy of this module, and a module-level variable would give each copy its own session. The default
 * driver and fixture factories below are plain module state: they are wired by the package entry in the same copy
 * that reads them.
 */
import { mkdirSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { type DevtoolsFacet, type DevtoolsResult, devtoolsErr } from "./devtools/devtools.types";
import { openDevtoolsFacet } from "./devtools/facet";
import type { NativeLogDeps } from "./devtools/native-log";
import type { Driver, DriverResult } from "./driver/driver.types";
import {
	type HidRecoveryDeps,
	rebootSim,
	restartRunnerHost,
	runAfterReboot,
	stopResidentHelper,
} from "./driver/ios/hid-recovery";
import { cacheObservations } from "./driver/observation-cache";
import { traceDriver } from "./driver/traced-driver";
import { type E2eEnv, readEnv } from "./env";
import { E2eError } from "./errors";
import type { AttemptContext, FixtureFactory } from "./runner/fixtures.types";
import { openResults, type ResultsWriter } from "./runner/results";
import { runSpan, type SpanRunner } from "./runner/span";
import { runStep } from "./runner/step";
import type { TraceWriter } from "./runner/trace";

/** A biometrics enroll right after a boot can be dropped: re-apply until the read-back shows enrolled. */
const ENROLL_TRIES = 5;
const ENROLL_RETRY_MS = 500;

export type DriverFactory = (env: E2eEnv) => DriverResult<Driver>;

/** How to attach to the app's dev client; default {@link openDevtools}. Tests inject a stub. */
export type DevtoolsOpener = (env: E2eEnv) => Promise<DevtoolsResult<DevtoolsFacet>>;

/**
 * Which inspector page is this env's: the bundle id and the device name. Several devices can share one Metro;
 * without the name the newest page of any device would win and a reload or evaluate would hit another device's app.
 */
export function devtoolsTarget(env: E2eEnv): { appId: string; deviceName?: string } {
	return { appId: env.bundleId, ...(env.deviceName === undefined ? {} : { deviceName: env.deviceName }) };
}

/**
 * Metro's inspector for this env's app (`WARDEN_METRO_URL`), pinned by {@link devtoolsTarget}. LogBox is kept off:
 * its toasts and inspector cover the app and take taps, while the logs still reach the console capture.
 */
export const openDevtools: DevtoolsOpener = (env) =>
	openDevtoolsFacet({
		env: { metroUrl: env.metroUrl },
		device: devtoolsTarget(env),
		fetch,
		WebSocket,
		timeoutMs: 5_000,
		log: (line) => process.stderr.write(`[devtools] ${line}\n`),
		muteLogBox: true,
	});

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
	/** parsed env; default `readEnv(process.env)` (throws `SESSION` when not under warden) */
	env?: E2eEnv;
	/** how to open the device; default {@link setDefaultDriverFactory}'s */
	driverFactory?: DriverFactory;
	/** how to attach devtools; default {@link openDevtools} */
	devtools?: DevtoolsOpener;
	/** native log reader; default {@link setDefaultNativeLog}'s */
	nativeLog?: NativeLogDeps;
	/** sim reboot seams; default {@link setDefaultHidRecovery}'s */
	hidRecovery?: HidRecoveryDeps;
	/** fixture factory; default {@link setDefaultFixtureFactory}'s */
	fixtures?: FixtureFactory;
	/** console line sink; default writes to fd 1 (bun test captures `process.stdout`, fd 1 is not captured) */
	log?: (line: string) => void;
	/** close from `process.on("exit")`; default true */
	exitHook?: boolean;
};

const SESSION_KEY = Symbol.for("@delacour/warden-e2e/session");
type SessionSlot = { [SESSION_KEY]?: Session };
const slot = (): SessionSlot => globalThis as SessionSlot;

let defaultFactory: DriverFactory | undefined;
let defaultFixtures: FixtureFactory | undefined;
let defaultNativeLog: NativeLogDeps | undefined;
let defaultHidRecovery: HidRecoveryDeps | undefined;

/** Wires the HID-loss recovery used when a session gets none (`preload.ts` registers the real one). */
export function setDefaultHidRecovery(deps: HidRecoveryDeps | undefined): void {
	defaultHidRecovery = deps;
}

/** Wires the native-log reader used when a session gets none (`preload.ts` registers the real one). */
export function setDefaultNativeLog(deps: NativeLogDeps | undefined): void {
	defaultNativeLog = deps;
}

/** Wires the factory used when `getSession` gets none (`driver/open.ts`'s opener, set by the package entry). */
export function setDefaultDriverFactory(factory: DriverFactory | undefined): void {
	defaultFactory = factory;
}

/** Whether a default driver factory is wired (so the preload leaves a test-installed fake alone). */
export function hasDefaultDriverFactory(): boolean {
	return defaultFactory !== undefined;
}

/** Wires the `app`/`device`/`screen` factory used when `getSession` gets none. */
export function setDefaultFixtureFactory(factory: FixtureFactory | undefined): void {
	defaultFixtures = factory;
}

/** Whether a default fixture factory is wired (so the preload leaves a test-installed one alone). */
export function hasDefaultFixtureFactory(): boolean {
	return defaultFixtures !== undefined;
}

const missingFactory: DriverFactory = async () => ({
	success: false,
	error: {
		code: "E_INTERNAL",
		message: "no driver factory configured (setDefaultDriverFactory was never called)",
		retryable: false,
	},
});

function writeLine(line: string): void {
	try {
		writeSync(1, `${line}\n`);
	} catch {
		// a closed stdout must not fail a test
	}
}

function resolveEnv(env: E2eEnv | undefined): E2eEnv {
	if (env !== undefined) return env;
	const read = readEnv(process.env);
	if (!read.success) throw new E2eError("SESSION", `invalid warden e2e environment:\n${read.error}`);
	if (read.data === undefined) throw new E2eError("SESSION", "not running under warden: WARDEN_UDID is not set");
	return read.data;
}

const WARM_TRIES = 15;
const WARM_INTERVAL_MS = 2_000;

export function createSession(opts: SessionOptions = {}): Session {
	const resolved = resolveEnv(opts.env);
	const factory = opts.driverFactory ?? defaultFactory ?? missingFactory;
	const out = resolve(resolved.out);
	mkdirSync(out, { recursive: true });
	const results = openResults(resolve(out, "results.jsonl"));
	const idle = new AbortController().signal;

	let opened: Promise<Driver> | undefined;
	let current: Driver | undefined;
	let closing: Promise<void> | undefined;
	let devtoolsOpening: Promise<DevtoolsResult<DevtoolsFacet>> | undefined;
	let facet: DevtoolsFacet | undefined;
	const openFacet = opts.devtools ?? openDevtools;
	let attempt: AttemptContext | undefined;

	const hid = opts.hidRecovery ?? defaultHidRecovery;
	let hidRecovered = false;
	const note = (line: string): void => (opts.log ?? writeLine)(line);

	async function resetDevice(): Promise<void> {
		const driver = opened;
		opened = undefined;
		current = undefined;
		await driver?.then(
			(d) => d.close(),
			() => undefined
		);
		const attaching = devtoolsOpening;
		devtoolsOpening = undefined;
		facet = undefined;
		await attaching?.then(
			(result) => (result.success ? result.data.close() : undefined),
			() => undefined
		);
	}

	/**
	 * A freshly booted sim answers the first accessibility reads with `E_AX_UNAVAILABLE` until the in-sim bridge binds
	 * (what `warden e2e`'s warm step waits out): snapshot until one succeeds, a few times, then carry on regardless.
	 */
	async function warmBridge(): Promise<void> {
		const sleep = hid?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		for (let tries = 0; tries < WARM_TRIES; tries += 1) {
			try {
				const driver = await session.driver();
				if ((await driver.snapshot()).success) return;
			} catch {
				// not up yet: try again
			}
			await sleep(WARM_INTERVAL_MS);
		}
	}

	/** A physical iPhone: restart its runner host once. The phone is never rebooted and `simctl` is never run. */
	async function recoverRunner(deps: HidRecoveryDeps, name: string): Promise<boolean> {
		if (hidRecovered) {
			note(`iPhone ${name}: the runner connection was lost again after a restart; check the phone and retry`);
			return false;
		}
		hidRecovered = true;
		await resetDevice();
		const restarted = await restartRunnerHost(deps, resolved.iosRunnerRestart, resolved.udid);
		if (!restarted.success) {
			note(`iPhone ${name}: runner connection lost, restart failed: ${restarted.error}`);
			return false;
		}
		note(`iPhone ${name}: runner connection lost, runner host restarted; running the test again`);
		return true;
	}

	/** Only the device `warden e2e` leased (this session's `WARDEN_UDID`), only once: a second loss fails as before. */
	async function recoverHid(): Promise<boolean> {
		if (hid === undefined || closing !== undefined) return false;
		const name = resolved.deviceName ?? resolved.udid;
		if (resolved.deviceKind === "physical") return recoverRunner(hid, name);
		if (hidRecovered) {
			note(`sim ${name}: HID connection lost again after a reboot; \`warden release <id> --shutdown\` and retry`);
			return false;
		}
		hidRecovered = true;
		await resetDevice();
		if (resolved.simdSocket !== undefined) {
			const stopped = await stopResidentHelper(hid, resolved.simdSocket);
			if (!stopped.success) note(`sim ${name}: ${stopped.error}`);
		}
		const rebooted = await rebootSim(hid, resolved.udid);
		if (!rebooted.success) {
			note(
				`sim ${name}: HID connection lost, reboot failed: ${rebooted.error}; \`warden release <id> --shutdown\` and retry`
			);
			return false;
		}
		await runAfterReboot({ ...hid, log: note }, resolved.afterReboot, resolved.udid);
		await warmBridge();
		note(`sim ${name}: HID connection lost (Device Hub quit?), rebooted; running the test again`);
		return true;
	}

	/**
	 * A biometrics iOS sim is enrolled again when the session opens, before any app install: a reused booted sim
	 * is left unenrolled by a spec that called `unenroll`. Best effort and idempotent; Android keeps its enrollment
	 * in the golden snapshot.
	 */
	async function reenroll(driver: Driver): Promise<Driver> {
		if (resolved.biometrics !== true || resolved.platform !== "ios") return driver;
		const sleep = hid?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		for (let attempt = 1; attempt <= ENROLL_TRIES; attempt += 1) {
			const state = await driver.biometrics("enroll");
			if (!state.success) {
				note(`biometrics enroll failed: ${state.error.code}: ${state.error.message}`);
				return driver;
			}
			if (state.data.enrolled) return driver;
			if (attempt < ENROLL_TRIES) await sleep(ENROLL_RETRY_MS);
		}
		note(`biometrics enroll did not take after ${ENROLL_TRIES} attempts`);
		return driver;
	}

	const session: Session = {
		env: resolved,
		out,
		results,
		fixtures: opts.fixtures ?? defaultFixtures,
		nativeLog: opts.nativeLog ?? defaultNativeLog,
		recoverHid: hid === undefined || resolved.platform !== "ios" ? undefined : recoverHid,
		resetDevice,
		log: opts.log ?? writeLine,
		get attempt() {
			return attempt;
		},
		get signal() {
			return attempt?.signal ?? idle;
		},
		get attemptDir() {
			return attempt?.dir;
		},
		get trace() {
			return attempt?.trace;
		},
		driver() {
			if (closing !== undefined) {
				return Promise.reject(new E2eError("SESSION", "session is closed"));
			}
			opened ??= factory(resolved).then(
				(result) => {
					if (!result.success) {
						opened = undefined;
						const { code, message } = result.error;
						throw new E2eError("DRIVER", `${code}: ${message}`);
					}
					current = cacheObservations(traceDriver(result.data, { trace: () => attempt?.trace }));
					return reenroll(current);
				},
				(cause: unknown) => {
					opened = undefined;
					throw new E2eError("DRIVER", cause instanceof Error ? cause.message : String(cause));
				}
			);
			return opened;
		},
		peekDriver() {
			return current;
		},
		devtools() {
			if (closing !== undefined) return Promise.resolve(devtoolsErr("devtools_unavailable", "session is closed"));
			if (resolved.metroUrl === undefined) {
				return Promise.resolve(
					devtoolsErr("devtools_unavailable", "no Metro URL (WARDEN_METRO_URL): release builds have no devtools")
				);
			}
			if (devtoolsOpening !== undefined) return devtoolsOpening;
			const opening = openFacet(resolved).then(
				(result) => {
					if (!result.success) {
						if (devtoolsOpening === opening) devtoolsOpening = undefined;
						return result;
					}
					const opened = result.data;
					facet = opened;
					// a facet that gave up reconnecting (an app relaunch outlasted its budget) is dropped, so the next
					// call attaches again and failure capture never writes a dead facet's rings
					opened.on("lost", () => {
						if (facet !== opened) return;
						facet = undefined;
						if (devtoolsOpening === opening) devtoolsOpening = undefined;
						opened.close();
					});
					return result;
				},
				(cause: unknown) => {
					if (devtoolsOpening === opening) devtoolsOpening = undefined;
					return devtoolsErr("devtools_unavailable", cause instanceof Error ? cause.message : String(cause));
				}
			);
			devtoolsOpening = opening;
			return opening;
		},
		peekDevtools() {
			return facet;
		},
		step(kind, label, fn) {
			return runStep(attempt, kind, label, fn);
		},
		span(op, fn, options) {
			return runSpan(attempt?.trace, op, fn, options);
		},
		enterAttempt(next, replacing) {
			if (replacing !== undefined && attempt !== replacing) return;
			attempt = next;
		},
		leaveAttempt(leaving) {
			if (leaving !== undefined && attempt !== leaving) return;
			attempt = undefined;
		},
		close() {
			closing ??= (async () => {
				if (opened !== undefined) {
					await opened.then(
						(d) => d.close(),
						() => undefined
					);
				}
				current = undefined;
				if (devtoolsOpening !== undefined) {
					await devtoolsOpening.then(
						(result) => (result.success ? result.data.close() : undefined),
						() => undefined
					);
				}
				facet = undefined;
				if (slot()[SESSION_KEY] === session) delete slot()[SESSION_KEY];
				if (exitListener !== undefined) process.off("exit", exitListener);
			})();
			return closing;
		},
	};

	// `exit` handlers are synchronous: the best we can do is start the close
	const exitListener: (() => void) | undefined =
		opts.exitHook === false
			? undefined
			: () => {
					void session.close();
				};
	if (exitListener !== undefined) process.on("exit", exitListener);
	return session;
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
export function attemptSession(session: Session, binding: () => AttemptBinding): Session {
	const context = (): AttemptContext => binding().context;
	const trace = (): TraceWriter | undefined => (binding().finished ? undefined : context().trace);
	return {
		get env() {
			return session.env;
		},
		get out() {
			return session.out;
		},
		get results() {
			return session.results;
		},
		get nativeLog() {
			return session.nativeLog;
		},
		get recoverHid() {
			return session.recoverHid;
		},
		resetDevice: () => session.resetDevice(),
		get fixtures() {
			return session.fixtures;
		},
		set fixtures(factory) {
			session.fixtures = factory;
		},
		get log() {
			return session.log;
		},
		get attempt() {
			return binding().finished ? undefined : context();
		},
		get signal() {
			return context().signal;
		},
		get attemptDir() {
			return context().dir;
		},
		get trace() {
			return trace();
		},
		driver: () => session.driver(),
		peekDriver: () => session.peekDriver(),
		devtools: () => session.devtools(),
		peekDevtools: () => session.peekDevtools(),
		step(kind, label, fn) {
			return runStep(context(), kind, label, fn);
		},
		span(op, fn, options) {
			return runSpan(trace(), op, fn, options);
		},
		enterAttempt: (next, replacing) => session.enterAttempt(next, replacing),
		leaveAttempt: (leaving) => session.leaveAttempt(leaving),
		close: () => session.close(),
	};
}

/** The process-wide session (`globalThis[Symbol.for("@delacour/warden-e2e/session")]`), created on first call. */
export function getSession(opts: SessionOptions = {}): Session {
	const existing = slot()[SESSION_KEY];
	if (existing !== undefined) return existing;
	const session = createSession(opts);
	slot()[SESSION_KEY] = session;
	return session;
}

/** Closes and forgets the process-wide session, if any. */
export async function resetSession(): Promise<void> {
	await slot()[SESSION_KEY]?.close();
	delete slot()[SESSION_KEY];
}
