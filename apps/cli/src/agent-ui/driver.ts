import { androidTools } from "@delacour/warden-core/providers/android";
import { openAndroidDriver } from "@delacour/warden-e2e/driver/android/android-driver";
import type { Driver, DriverError } from "@delacour/warden-e2e/driver/driver.types";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import { connectHelper } from "./helper";
import { type UiError, uiError } from "./output";
import type { RecordSink } from "./record";
import type { VideoDeps } from "./video";

/** Everything `warden ui` subcommands reach the outside world through; tests inject a `fakeDriver` and a fake clock. */
export type UiDeps = {
	/** open a driver for a leased device (the caller closes it) */
	driver: (ctx: CommandContext, device: UiDevice) => Promise<Result<Driver, UiError>>;
	sleep: (ms: number) => Promise<void>;
	/** the active flow recording's sink (default: nothing is recorded) */
	record?: RecordSink;
	/** how `video start|stop` runs the recorder process (default: real processes) */
	video?: VideoDeps;
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
 * The real driver for a device. iOS: the device's `warden-simd` daemon (`connectHelper` spawns it on first
 * use, closing the driver only disconnects). Android: an adb-backed driver owned by this command (closed with it).
 */
export async function uiDriver(ctx: CommandContext, device: UiDevice): Promise<Result<Driver, UiError>> {
	if (device.platform === "ios") return connectHelper(ctx, device.udid);
	return fromDriver(await openAndroidDriver({ serial: device.udid, adb: androidTools(ctx.env).adb, exec: ctx.exec }));
}

export const defaultUiDeps: UiDeps = {
	driver: uiDriver,
	sleep: (ms) => Bun.sleep(ms),
};

/** `ok`/`err` helper for driver calls inside `warden ui`: DriverError → UiError. */
export function fromDriver<T>(result: Result<T, DriverError>): Result<T, UiError> {
	return result.success ? ok(result.data) : { success: false, error: driverUiError(result.error) };
}
