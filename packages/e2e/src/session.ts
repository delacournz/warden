import { mkdirSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import type { Driver, DriverResult } from "./driver/driver.types";
import { type E2eEnv, readEnv } from "./env";
import { E2eError } from "./errors";
import type { AttemptContext, FixtureFactory } from "./runner/fixtures.types";
import { openResults, type ResultsWriter } from "./runner/results";
import { runStep } from "./runner/step";
import type { TraceWriter } from "./runner/trace";

export type DriverFactory = (env: E2eEnv) => DriverResult<Driver>;

export type Session = {
	readonly env: E2eEnv;
	/** absolute `WARDEN_E2E_OUT` */
	readonly out: string;
	readonly results: ResultsWriter;
	/** builds `app`/`device`/`screen` for each attempt (T4/T6); settable so tests can fake it */
	fixtures: FixtureFactory | undefined;
	/** where the console reporter prints one line; default fd 1 */
	readonly log: (line: string) => void;
	/** the running attempt, if any */
	readonly attempt: AttemptContext | undefined;
	/**
	 * Failures `expect.soft` recorded without throwing. The runner empties it when an attempt starts and
	 * fails the attempt after the body if it is not empty.
	 */
	readonly softFailures: Error[];
	/** aborts at the running attempt's deadline; never aborts outside an attempt. Pass it to every driver call and poll. */
	readonly signal: AbortSignal;
	/** the running attempt's artifacts dir and `trace.jsonl` (read at call time by the `app`/`device` fixtures) */
	readonly attemptDir: string | undefined;
	readonly trace: TraceWriter | undefined;
	/** opened on first call, then shared; a failed open is thrown as `E2eError{code:"DRIVER"}` and retried next call */
	driver(): Promise<Driver>;
	/** the driver if it is already open; never opens one (failure capture must not start a device) */
	peekDriver(): Driver | undefined;
	/** one reported step (`▸`/`▪` lines, `trace.jsonl`) that gives up when the attempt deadline aborts */
	step<T>(kind: string, label: string, fn: () => Promise<T>): Promise<T>;
	enterAttempt(attempt: AttemptContext): void;
	leaveAttempt(): void;
	/** idempotent; closes the driver only if it was opened */
	close(): Promise<void>;
};

export type SessionOptions = {
	/** parsed env; default `readEnv(process.env)` (throws `SESSION` when not under warden) */
	env?: E2eEnv;
	/** how to open the device; default {@link setDefaultDriverFactory}'s */
	driverFactory?: DriverFactory;
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
	let attempt: AttemptContext | undefined;

	const session: Session = {
		env: resolved,
		out,
		results,
		fixtures: opts.fixtures ?? defaultFixtures,
		log: opts.log ?? writeLine,
		get attempt() {
			return attempt;
		},
		softFailures: [],
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
					current = result.data;
					return result.data;
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
		step(kind, label, fn) {
			return runStep(attempt, kind, label, fn);
		},
		enterAttempt(next) {
			attempt = next;
		},
		leaveAttempt() {
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
