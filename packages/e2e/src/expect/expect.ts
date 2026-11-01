import { type Expect as BunExpect, expect as bunExpect, type Matchers } from "bun:test";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { type Locator, locatorSupport } from "@delacour/warden-screen/locator";
import { LocatorAssertions } from "@delacour/warden-screen/matchers";
import { type Session, sessions } from "../session";

/** Receives a failure `expect.soft` kept instead of throwing. */
export type SoftSink = (error: E2eError) => void;

/** `expect.soft`: `expect` whose failures are kept on the running attempt, which fails once its body has settled. */
export type SoftExpect = {
	(actual: Locator): LocatorAssertions;
	<T = unknown>(actual: T, message?: string): Matchers<T>;
};

/**
 * The spec `expect`: `expect(locator)` gives the polling locator matchers, anything else is bun's own `expect`
 * (all of its statics — `any`, `arrayContaining`, `extend`, `not`, … — are on it too).
 */
export type E2eExpect = ((actual: Locator) => LocatorAssertions) &
	BunExpect & {
		readonly soft: SoftExpect;
	};

export type ExpectDeps = {
	/** where `expect.soft` keeps failures right now; undefined (outside an attempt) means throw as usual */
	softSink: () => SoftSink | undefined;
};

const valueExpect = bunExpect as unknown as (actual?: unknown, message?: string) => object;

const NOT_STATIC = new Set<string | symbol>(["length", "name", "prototype"]);

export class ExpectFactory {
	/** The running attempt's collector (`AttemptContext.softFailures`), if a test is running. */
	softSinkFor(session: Pick<Session, "attempt">): SoftSink | undefined {
		const failures = session.attempt?.softFailures;
		return failures === undefined ? undefined : (error) => void failures.push(error);
	}

	/** The soft sink of the process session; undefined when not under warden. */
	currentSoftSink(): SoftSink | undefined {
		try {
			return this.softSinkFor(sessions.get());
		} catch {
			// not under warden: there is no attempt to collect for
			return undefined;
		}
	}

	create(deps: ExpectDeps): E2eExpect {
		const call = (actual?: unknown, message?: string): unknown =>
			locatorSupport.isLocator(actual)
				? new LocatorAssertions(actual, { negate: false })
				: valueExpect(actual, message);

		const soft = (actual?: unknown, message?: string): unknown => {
			const sink = deps.softSink();
			if (locatorSupport.isLocator(actual))
				return new LocatorAssertions(actual, { negate: false, ...(sink === undefined ? {} : { soft: sink }) });
			const matchers = valueExpect(actual, message);
			return sink === undefined ? matchers : this.softMatchers(matchers, sink);
		};

		// bun's statics (`any`, `extend`, `not`, ...) are forwarded live, functions bound to bun's own `expect`
		for (const key of Reflect.ownKeys(bunExpect)) {
			if (NOT_STATIC.has(key)) continue;
			Object.defineProperty(call, key, {
				enumerable: true,
				get() {
					const value: unknown = Reflect.get(bunExpect, key);
					return typeof value === "function" ? value.bind(bunExpect) : value;
				},
			});
		}
		Object.defineProperty(call, "soft", { enumerable: true, value: soft });
		return call as unknown as E2eExpect;
	}

	private asAssertion(error: unknown): E2eError {
		if (error instanceof E2eError) return error;
		return new E2eError("ASSERTION", error instanceof Error ? error.message : String(error));
	}

	private isThenable(value: unknown): value is PromiseLike<unknown> {
		return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
	}

	/** bun's matchers with every failure (sync or from `.resolves` / `.rejects`) sent to `sink` instead of thrown. */
	private softMatchers<T extends object>(target: T, sink: SoftSink): T {
		return new Proxy(target, {
			get: (object, property) => {
				const value: unknown = Reflect.get(object, property, object);
				if (typeof value === "function") {
					return (...args: unknown[]): unknown => {
						try {
							const result: unknown = Reflect.apply(value, object, args);
							return this.isThenable(result)
								? Promise.resolve(result).catch((e: unknown) => sink(this.asAssertion(e)))
								: result;
						} catch (error) {
							sink(this.asAssertion(error));
							return undefined;
						}
					};
				}
				if (typeof value === "object" && value !== null) return this.softMatchers(value, sink);
				return value;
			},
		});
	}
}

export const expectFactory = new ExpectFactory();

export const expect: E2eExpect = expectFactory.create({ softSink: () => expectFactory.currentSoftSink() });
