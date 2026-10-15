import type { Result } from "@delacour/warden-types/result";
import { E2eError, type E2eErrorCode } from "../errors";
import type { DriverError, DriverErrorCode, DriverResult } from "./driver.types";

const TIMEOUTS: ReadonlySet<DriverErrorCode> = new Set<DriverErrorCode>(["E_TIMEOUT", "E_APP_NOT_RESPONDING"]);

const INFRASTRUCTURE: ReadonlySet<DriverErrorCode> = new Set<DriverErrorCode>([
	"E_HELPER_MISSING",
	"E_HELPER_CRASHED",
	"E_NOT_BOOTED",
	"E_UNKNOWN_DEVICE",
	"E_AX_UNAVAILABLE",
	"E_APP_UNAVAILABLE",
	"E_INTERNAL",
]);

function codeFor(code: DriverErrorCode): E2eErrorCode {
	if (TIMEOUTS.has(code)) return "TIMEOUT";
	if (INFRASTRUCTURE.has(code)) return "DRIVER";
	return "ACTION_FAILED";
}

/** `TIMEOUT` for time limits, `DRIVER` when the helper / device is broken, else `ACTION_FAILED`. */
export function toE2eError(error: DriverError, action: string): E2eError {
	return new E2eError(codeFor(error.code), `${action} failed: ${error.code}: ${error.message}`);
}

function aborted(action: string, signal: AbortSignal): E2eError {
	const reason: unknown = signal.reason;
	const detail = reason instanceof Error ? `: ${reason.message}` : "";
	return new E2eError("TIMEOUT", `${action} aborted (test deadline reached or cancelled)${detail}`);
}

/**
 * Runs one driver call, racing it against `signal`: an already-aborted signal never starts the call,
 * an abort while it runs rejects with `E2eError{TIMEOUT}`. Returns the raw `Result` (use {@link unwrap}
 * when a failure should throw).
 */
export async function settled<T>(
	call: () => DriverResult<T>,
	action: string,
	signal?: AbortSignal
): Promise<Result<T, DriverError>> {
	if (signal === undefined) return call();
	if (signal.aborted) throw aborted(action, signal);
	let onAbort: (() => void) | undefined;
	const abort = new Promise<never>((_, reject) => {
		onAbort = () => reject(aborted(action, signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([call(), abort]);
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

/** {@link settled}, throwing the mapped `E2eError` (see {@link toE2eError}) on a driver failure. */
export async function unwrap<T>(call: () => DriverResult<T>, action: string, signal?: AbortSignal): Promise<T> {
	const result = await settled(call, action, signal);
	if (!result.success) throw toE2eError(result.error, action);
	return result.data;
}
