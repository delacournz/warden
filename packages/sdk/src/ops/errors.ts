import type { DriverError } from "@delacour/warden-driver/driver.types";
import { type WardenError, type WardenErrorCode, type WardenErrorExtra, wardenErr } from "@delacour/warden-types/error";
import { ok, type Result } from "@delacour/warden-types/result";

/** A coded {@link WardenError} value (not wrapped in a `Result`). Optional fields are omitted unless given. */
export function opError(code: WardenErrorCode, message: string, extra: WardenErrorExtra = {}): WardenError {
	return wardenErr(code, message, extra).error;
}

/** A failed `Result` over an op error: `return fail(opError(...))`. */
export function fail(error: WardenError): { success: false; error: WardenError } {
	return { success: false, error };
}

const ENGINE_CODES: ReadonlySet<DriverError["code"]> = new Set<DriverError["code"]>([
	"E_HELPER_MISSING",
	"E_HELPER_CRASHED",
	"E_AX_UNAVAILABLE",
	"E_NOT_BOOTED",
	"E_UNKNOWN_DEVICE",
]);

/** A phone behind a PIN / pattern / password: a person must unlock it, warden never does. */
export const DEVICE_LOCKED_HINT = "unlock the phone, then retry";

/**
 * A driver failure as a {@link WardenError}: a locked phone is `device_locked`, engine problems are
 * `engine_unavailable`, a stale ref `stale_ref`, the rest `failed`.
 */
export function driverError(error: DriverError): WardenError {
	const message = `${error.code}: ${error.message}`;
	if (error.code === "E_STALE_REF") {
		return opError("stale_ref", error.message, { hint: "run `warden ui snapshot` again" });
	}
	if (error.code === "E_DEVICE_LOCKED") return opError("device_locked", message, { hint: DEVICE_LOCKED_HINT });
	if (ENGINE_CODES.has(error.code)) return opError("engine_unavailable", message);
	return opError("failed", message, { details: { driver: error.code } });
}

/** `DriverError` → {@link WardenError} on a driver call's `Result`. */
export function fromDriver<T>(result: Result<T, DriverError>): Result<T, WardenError> {
	return result.success ? ok(result.data) : fail(driverError(result.error));
}
