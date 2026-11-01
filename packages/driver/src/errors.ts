import type { ErrorResult } from "@delacour/warden-types/result";
import type { DriverError, DriverErrorCode } from "./driver.types";

const RETRYABLE: ReadonlySet<DriverErrorCode> = new Set<DriverErrorCode>([
	"E_TIMEOUT",
	"E_HELPER_CRASHED",
	"E_AX_UNAVAILABLE",
	"E_APP_NOT_RESPONDING",
	"E_STALE_REF",
]);

type DriverErrorExtra = { retryable?: boolean; detail?: unknown };

/** Builds {@link DriverError} values. Use the shared {@link driverErrors} singleton. */
export class DriverErrors {
	make(code: DriverErrorCode, message: string, extra: DriverErrorExtra = {}): DriverError {
		return {
			code,
			message,
			retryable: extra.retryable ?? RETRYABLE.has(code),
			...(extra.detail !== undefined ? { detail: extra.detail } : {}),
		};
	}

	/** `err()` for `DriverResult`. */
	err(code: DriverErrorCode, message: string, extra?: DriverErrorExtra): ErrorResult<DriverError> {
		return { success: false, error: this.make(code, message, extra) };
	}

	/** One line for logs and CLI output. */
	describe(error: DriverError): string {
		return `${error.code}: ${error.message}`;
	}
}

export const driverErrors = new DriverErrors();
