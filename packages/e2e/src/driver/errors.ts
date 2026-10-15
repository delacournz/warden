import type { ErrorResult } from "@delacour/warden-types/result";
import type { DriverError, DriverErrorCode } from "./driver.types";

const RETRYABLE: ReadonlySet<DriverErrorCode> = new Set<DriverErrorCode>([
	"E_TIMEOUT",
	"E_HELPER_CRASHED",
	"E_AX_UNAVAILABLE",
	"E_APP_NOT_RESPONDING",
	"E_STALE_REF",
]);

export function driverError(
	code: DriverErrorCode,
	message: string,
	extra: { retryable?: boolean; detail?: unknown } = {}
): DriverError {
	return {
		code,
		message,
		retryable: extra.retryable ?? RETRYABLE.has(code),
		...(extra.detail !== undefined ? { detail: extra.detail } : {}),
	};
}

/** `err()` for `DriverResult`. */
export function driverErr(
	code: DriverErrorCode,
	message: string,
	extra?: { retryable?: boolean; detail?: unknown }
): ErrorResult<DriverError> {
	return { success: false, error: driverError(code, message, extra) };
}

/** One line for logs and CLI output. */
export function describeDriverError(error: DriverError): string {
	return `${error.code}: ${error.message}`;
}
