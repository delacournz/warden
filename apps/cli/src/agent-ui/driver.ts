import type { Driver, DriverError } from "@delacour/warden-e2e/driver/driver.types";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import { type UiError, uiError } from "./output";

/** Everything `warden ui` subcommands reach the outside world through; tests inject a `fakeDriver` and a fake clock. */
export type UiDeps = {
	/** open a driver for a leased device (the caller closes it) */
	driver: (ctx: CommandContext, device: UiDevice) => Promise<Result<Driver, UiError>>;
	sleep: (ms: number) => Promise<void>;
};

const ENGINE_CODES: ReadonlySet<DriverError["code"]> = new Set<DriverError["code"]>([
	"E_HELPER_MISSING",
	"E_HELPER_CRASHED",
	"E_AX_UNAVAILABLE",
	"E_NOT_BOOTED",
	"E_UNKNOWN_DEVICE",
]);

/** A driver failure as a `warden ui` error: engine problems exit 3, a stale ref exits 4, the rest exit 1. */
export function driverUiError(error: DriverError): UiError {
	const message = `${error.code}: ${error.message}`;
	if (error.code === "E_STALE_REF") {
		return uiError("stale_ref", error.message, { hint: "run `warden ui snapshot` again" });
	}
	if (ENGINE_CODES.has(error.code)) return uiError("engine_unavailable", message);
	return uiError("failed", message, { details: { driver: error.code } });
}

/**
 * The real driver for a device. The iOS driver (`driver/ios/ios-driver.ts`, WDN-E2E-D7) and the Android
 * one are not on this branch yet, so for now every device reports `engine_unavailable` (exit 3); swap the
 * body for `openIosDriver` / `openAndroidDriver` when they land. Tests inject their own `UiDeps`.
 */
export async function uiDriver(_ctx: CommandContext, device: UiDevice): Promise<Result<Driver, UiError>> {
	return {
		success: false,
		error: uiError("engine_unavailable", `no ${device.platform} driver is available in this build`, {
			hint: "the device driver lands with WDN-E2E-D7 (iOS) / D9 (Android)",
		}),
	};
}

export const defaultUiDeps: UiDeps = {
	driver: uiDriver,
	sleep: (ms) => Bun.sleep(ms),
};

/** `ok`/`err` helper for driver calls inside `warden ui`: DriverError → UiError. */
export function fromDriver<T>(result: Result<T, DriverError>): Result<T, UiError> {
	return result.success ? ok(result.data) : { success: false, error: driverUiError(result.error) };
}
