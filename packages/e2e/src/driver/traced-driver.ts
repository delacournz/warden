import { codeOf, type SpanOutcome, type SpanSink, writeSpan } from "../runner/span";
import type { Driver } from "./driver.types";
import { collectSpanDetail, type SpanDetail } from "./span-detail";

export type TracedDriverOptions = {
	/** where spans go right now: the running attempt's trace, `undefined` between attempts. Read per call. */
	trace: () => SpanSink | undefined;
	now?: () => number;
};

/** Never spanned: not a driver call whose result means anything. */
const UNTRACED: ReadonlySet<string> = new Set(["close"]);

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

/** A driver's `{ success: false, error: { code } }`: a failed call that did not throw. */
function outcomeOf(value: unknown): SpanOutcome {
	if (typeof value !== "object" || value === null || !("success" in value) || value.success !== false) {
		return { ok: true };
	}
	const error = "error" in value ? value.error : undefined;
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	return typeof code === "string" ? { ok: false, code } : { ok: false };
}

/**
 * Wraps `driver` so every call it answers with a promise (`snapshot`, `tap`, `settle`, `app.launch`, and whatever
 * optional capability it offers, such as `pressKeyRepeat`) writes a `driver.<call>` span to the running attempt's
 * trace. It is a `Proxy`, so every other member (`platform`, `capabilities`, a synchronous method) reads through
 * unchanged, and nothing is recorded outside an attempt. Arguments are never recorded: `typeText` carries passwords.
 */
export function traceDriver<D extends Driver>(driver: D, options: TracedDriverOptions): D {
	const now = options.now ?? Date.now;

	const wrap = <O extends object>(target: O, prefix: string): O => {
		const wrapped = new Map<string, { source: unknown; wrapper: unknown }>();
		return new Proxy(target, {
			get(object, property) {
				const value: unknown = Reflect.get(object, property, object);
				if (typeof property !== "string") return value;
				const cached = wrapped.get(property);
				if (cached !== undefined && cached.source === value) return cached.wrapper;
				if (property === "app" && typeof value === "object" && value !== null) {
					const app = wrap(value, `${prefix}app.`);
					wrapped.set(property, { source: value, wrapper: app });
					return app;
				}
				if (typeof value !== "function" || UNTRACED.has(property)) return value;
				const call = (...args: unknown[]): unknown => {
					const sink = options.trace();
					if (sink === undefined) return Reflect.apply(value, object, args);
					const span = { op: `${prefix}${property}`, ts: now(), ms: 0, notes: {} as SpanDetail };
					const end = (): typeof span => ({ ...span, ms: now() - span.ts });
					let result: unknown;
					try {
						result = collectSpanDetail(span.notes, () => Reflect.apply(value, object, args));
					} catch (error) {
						writeSpan(sink, end(), () => ({ ok: false, code: codeOf(error) }));
						throw error;
					}
					if (!isThenable(result)) return result;
					return Promise.resolve(result).then(
						(resolved) => {
							writeSpan(sink, end(), () => outcomeOf(resolved));
							return resolved;
						},
						(error: unknown) => {
							writeSpan(sink, end(), () => ({ ok: false, code: codeOf(error) }));
							throw error;
						}
					);
				};
				wrapped.set(property, { source: value, wrapper: call });
				return call;
			},
		});
	};

	return wrap(driver, "driver.");
}
