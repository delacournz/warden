import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import type { DriverError } from "./driver.types";

const ENGINE_CODES: ReadonlySet<DriverError["code"]> = new Set<DriverError["code"]>([
	"E_HELPER_MISSING",
	"E_HELPER_CRASHED",
	"E_AX_UNAVAILABLE",
	"E_NOT_BOOTED",
	"E_UNKNOWN_DEVICE",
]);

/** Maps driver failures onto {@link WardenError}. Use the shared {@link driverWardenErrors} singleton. */
export class DriverWardenErrors {
	/** A driver failure as a {@link WardenError}: engine problems are `engine_unavailable`, a stale ref `stale_ref`, the rest `failed`. */
	fromDriver(error: DriverError): WardenError {
		const message = `${error.code}: ${error.message}`;
		if (error.code === "E_STALE_REF") {
			return wardenErrors.err("stale_ref", error.message, { hint: "run `warden ui snapshot` again" }).error;
		}
		if (ENGINE_CODES.has(error.code)) return wardenErrors.err("engine_unavailable", message).error;
		return wardenErrors.err("failed", message, { details: { driver: error.code } }).error;
	}
}

export const driverWardenErrors = new DriverWardenErrors();
