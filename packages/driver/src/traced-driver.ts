import type { Driver } from "./driver.types";
import { type SpanOutcome, type SpanSink, spans } from "./trace/span";
import { type SpanDetail, spanDetails } from "./trace/span-detail";

export type TracedDriverOptions = {
	/** where spans go right now: the running attempt's trace, `undefined` between attempts. Read per call. */
	trace: () => SpanSink | undefined;
	now?: () => number;
};

/** Never spanned: not a driver call whose result means anything. */
const UNTRACED: ReadonlySet<string> = new Set(["close"]);

/** One traced object (the driver, or its `app` group): a `Proxy` that spans every promise-returning call. */
class TracedProxy<O extends object> {
	private readonly wrapped = new Map<string, { source: unknown; wrapper: unknown }>();
	private readonly now: () => number;

	constructor(
		private readonly target: O,
		private readonly prefix: string,
		private readonly options: TracedDriverOptions
	) {
		this.now = options.now ?? Date.now;
	}

	proxy(): O {
		return new Proxy(this.target, { get: (object, property) => this.member(object, property) });
	}

	private member(object: O, property: string | symbol): unknown {
		const value: unknown = Reflect.get(object, property, object);
		if (typeof property !== "string") return value;
		const cached = this.wrapped.get(property);
		if (cached !== undefined && cached.source === value) return cached.wrapper;
		if (property === "app" && typeof value === "object" && value !== null) {
			const app = new TracedProxy(value, `${this.prefix}app.`, this.options).proxy();
			this.wrapped.set(property, { source: value, wrapper: app });
			return app;
		}
		if (typeof value !== "function" || UNTRACED.has(property)) return value;
		const call = (...args: unknown[]): unknown => this.traced(object, property, value, args);
		this.wrapped.set(property, { source: value, wrapper: call });
		return call;
	}

	private traced(object: O, property: string, fn: unknown, args: unknown[]): unknown {
		const sink = this.options.trace();
		if (sink === undefined) return Reflect.apply(fn as (...a: unknown[]) => unknown, object, args);
		const span = { op: `${this.prefix}${property}`, ts: this.now(), ms: 0, notes: {} as SpanDetail };
		const end = (): typeof span => ({ ...span, ms: this.now() - span.ts });
		let result: unknown;
		try {
			result = spanDetails.collect(span.notes, () => Reflect.apply(fn as (...a: unknown[]) => unknown, object, args));
		} catch (error) {
			spans.write(sink, end(), () => ({ ok: false, code: spans.codeOf(error) }));
			throw error;
		}
		if (!this.isThenable(result)) return result;
		return Promise.resolve(result).then(
			(resolved) => {
				spans.write(sink, end(), () => this.outcomeOf(resolved));
				return resolved;
			},
			(error: unknown) => {
				spans.write(sink, end(), () => ({ ok: false, code: spans.codeOf(error) }));
				throw error;
			}
		);
	}

	private isThenable(value: unknown): value is PromiseLike<unknown> {
		return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
	}

	/** A driver's `{ success: false, error: { code } }`: a failed call that did not throw. */
	private outcomeOf(value: unknown): SpanOutcome {
		if (typeof value !== "object" || value === null || !("success" in value) || value.success !== false) {
			return { ok: true };
		}
		const error = "error" in value ? value.error : undefined;
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		return typeof code === "string" ? { ok: false, code } : { ok: false };
	}
}

/** Wraps drivers so their calls leave spans. Use the shared {@link driverTracer} singleton. */
export class DriverTracer {
	/**
	 * Wraps `driver` so every call it answers with a promise (`snapshot`, `tap`, `settle`, `app.launch`, and whatever
	 * optional capability it offers, such as `pressKeyRepeat`) writes a `driver.<call>` span to the running attempt's
	 * trace. It is a `Proxy`, so every other member (`platform`, `capabilities`, a synchronous method) reads through
	 * unchanged, and nothing is recorded outside an attempt. Arguments are never recorded: `typeText` carries passwords.
	 */
	trace<D extends Driver>(driver: D, options: TracedDriverOptions): D {
		return new TracedProxy(driver, "driver.", options).proxy();
	}
}

export const driverTracer = new DriverTracer();
