import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import { isDriverInput } from "@delacour/warden-e2e/driver/observation-cache";

/** Members that are neither a read nor input to the device: ending the session. */
const NOT_INPUT: ReadonlySet<string> = new Set(["close"]);

type Call = (...args: unknown[]) => unknown;

function isCall(value: unknown): value is Call {
	return typeof value === "function";
}

/**
 * `driver`, with `onInput` run before every call that may change the screen (tap, typing, keys, swipes, gestures,
 * app launch / terminate / openUrl, rotation…; `isDriverInput`), including `driver.app.*`. Counted before the call so
 * an input that fails half-way (a fill whose read-back failed after the keyboard came up) still counts.
 */
export function watchInputs<D extends Driver>(driver: D, onInput: () => void): D {
	const wrap = <O extends object>(target: O): O =>
		new Proxy(target, {
			get(object, property) {
				const value: unknown = Reflect.get(object, property, object);
				if (typeof property !== "string") return value;
				if (property === "app" && typeof value === "object" && value !== null) return wrap(value);
				if (!isCall(value) || NOT_INPUT.has(property)) return value;
				return (...args: unknown[]): unknown => {
					if (isDriverInput(property, args)) onInput();
					return Reflect.apply(value, object, args);
				};
			},
		});
	return wrap(driver);
}
