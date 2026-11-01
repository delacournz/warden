import type { Result } from "@delacour/warden-types/result";
import type { DriverError, DriverErrorCode, DriverResult } from "./driver.types";
import { E2eError, type E2eErrorCode } from "./e2e-error";

const TIMEOUTS: ReadonlySet<DriverErrorCode> = new Set<DriverErrorCode>(["E_TIMEOUT", "E_APP_NOT_RESPONDING"]);

const INFRASTRUCTURE: ReadonlySet<DriverErrorCode> = new Set<DriverErrorCode>([
	"E_HELPER_MISSING",
	"E_HELPER_CRASHED",
	"E_NOT_BOOTED",
	"E_UNKNOWN_DEVICE",
	"E_AX_UNAVAILABLE",
	"E_APP_UNAVAILABLE",
	"E_INTERNAL",
	"E_DEVICE_LOCKED",
]);

/** Runs driver calls for specs, turning failures into {@link E2eError}. Use the shared {@link driverCalls} singleton. */
export class DriverCalls {
	/** `TIMEOUT` for time limits, `DRIVER` when the helper / device is broken, else `ACTION_FAILED`. */
	toE2eError(error: DriverError, action: string): E2eError {
		return new E2eError(this.codeFor(error.code), `${action} failed: ${error.code}: ${error.message}`);
	}

	/**
	 * Runs one driver call, racing it against `signal`: an already-aborted signal never starts the call,
	 * an abort while it runs rejects with `E2eError{TIMEOUT}`. Returns the raw `Result` (use {@link DriverCalls.unwrap}
	 * when a failure should throw).
	 */
	async settled<T>(call: () => DriverResult<T>, action: string, signal?: AbortSignal): Promise<Result<T, DriverError>> {
		if (signal === undefined) return call();
		if (signal.aborted) throw this.aborted(action, signal);
		let onAbort: (() => void) | undefined;
		const abort = new Promise<never>((_, reject) => {
			onAbort = () => reject(this.aborted(action, signal));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([call(), abort]);
		} finally {
			if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
		}
	}

	/** {@link DriverCalls.settled}, throwing the mapped `E2eError` (see {@link DriverCalls.toE2eError}) on a driver failure. */
	async unwrap<T>(call: () => DriverResult<T>, action: string, signal?: AbortSignal): Promise<T> {
		const result = await this.settled(call, action, signal);
		if (!result.success) throw this.toE2eError(result.error, action);
		return result.data;
	}

	private codeFor(code: DriverErrorCode): E2eErrorCode {
		if (TIMEOUTS.has(code)) return "TIMEOUT";
		if (INFRASTRUCTURE.has(code)) return "DRIVER";
		return "ACTION_FAILED";
	}

	private aborted(action: string, signal: AbortSignal): E2eError {
		const reason: unknown = signal.reason;
		const detail = reason instanceof Error ? `: ${reason.message}` : "";
		return new E2eError("TIMEOUT", `${action} aborted (test deadline reached or cancelled)${detail}`);
	}
}

export const driverCalls = new DriverCalls();
