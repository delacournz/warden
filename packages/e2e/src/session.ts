import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Driver, DriverResult } from "./driver/driver.types";
import { type E2eEnv, readEnv } from "./env";
import { E2eError } from "./errors";
import { openResults, type ResultsWriter } from "./runner/results";

export type DriverFactory = (env: E2eEnv) => DriverResult<Driver>;

export type Session = {
	readonly env: E2eEnv;
	/** absolute `WARDEN_E2E_OUT` */
	readonly out: string;
	readonly results: ResultsWriter;
	/** opened on first call, then shared; a failed open is thrown as `E2eError{code:"DRIVER"}` and retried next call */
	driver(): Promise<Driver>;
	/** idempotent; closes the driver only if it was opened */
	close(): Promise<void>;
};

export type SessionOptions = {
	/** parsed env; default `readEnv(process.env)` (throws `SESSION` when not under warden) */
	env?: E2eEnv;
	/** how to open the device; default {@link defaultDriverFactory} */
	driverFactory?: DriverFactory;
	/** close from `process.on("exit")`; default true */
	exitHook?: boolean;
};

const SESSION_KEY = Symbol.for("@delacour/warden-e2e/session");
type SessionSlot = { [SESSION_KEY]?: Session };
const slot = (): SessionSlot => globalThis as SessionSlot;

let defaultFactory: DriverFactory | undefined;

/** Wires the factory used when `getSession` gets none (`driver/open.ts`'s opener, set by the package entry). */
export function setDefaultDriverFactory(factory: DriverFactory | undefined): void {
	defaultFactory = factory;
}

const missingFactory: DriverFactory = async () => ({
	success: false,
	error: {
		code: "E_INTERNAL",
		message: "no driver factory configured (setDefaultDriverFactory was never called)",
		retryable: false,
	},
});

export function createSession(opts: SessionOptions = {}): Session {
	let env = opts.env;
	if (env === undefined) {
		const read = readEnv(process.env);
		if (!read.success) throw new E2eError("SESSION", `invalid warden e2e environment:\n${read.error}`);
		if (read.data === undefined) {
			throw new E2eError("SESSION", "not running under warden: WARDEN_UDID is not set");
		}
		env = read.data;
	}
	const resolved = env;
	const factory = opts.driverFactory ?? defaultFactory ?? missingFactory;
	const out = resolve(resolved.out);
	mkdirSync(out, { recursive: true });
	const results = openResults(resolve(out, "results.jsonl"));

	let opened: Promise<Driver> | undefined;
	let closing: Promise<void> | undefined;

	const session: Session = {
		env: resolved,
		out,
		results,
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
					return result.data;
				},
				(cause: unknown) => {
					opened = undefined;
					throw new E2eError("DRIVER", cause instanceof Error ? cause.message : String(cause));
				}
			);
			return opened;
		},
		close() {
			closing ??= (async () => {
				if (opened !== undefined) {
					await opened.then(
						(d) => d.close(),
						() => undefined
					);
				}
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
