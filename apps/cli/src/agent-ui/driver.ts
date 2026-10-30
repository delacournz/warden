import type { PidAlive } from "@delacour/warden-core/liveness";
import type { Driver, DriverError } from "@delacour/warden-e2e/driver/driver.types";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { RunEnsureApp } from "../lease-session";
import type { AuthoringDeps } from "./authoring-command";
import type { BenchDeps } from "./bench";
import type { ConditionsDeps } from "./conditions-types";
import type { UiDevice } from "./device";
import type { DevtoolsDeps } from "./devtools-cli";
import { type UiError, uiError } from "./output";
import type { RecordSink } from "./record";
import type { VideoDeps } from "./video";

/** Everything `warden ui` subcommands reach the outside world through; tests inject a `fakeDriver` and a fake clock. */
export type UiDeps = {
	/** open a driver for a leased device (the caller closes it) */
	driver: (ctx: CommandContext, device: UiDevice) => Promise<Result<Driver, UiError>>;
	sleep: (ms: number) => Promise<void>;
	/** the recording sink (default: the journal of the active `warden ui record`, if any) */
	record?: RecordSink;
	/** how `record start` finds the suite and `record stop` verifies the spec (default: the suite config and the spec runner) */
	authoring?: AuthoringDeps;
	/** how `video start|stop` runs the recorder process (default: real processes) */
	video?: VideoDeps;
	/** how the devtools subcommands (eval, tree, logs, network, reload) reach Metro and spawn the collector */
	devtools?: DevtoolsDeps;
	/** clock and helper/driver plumbing of `bench` (default: wall clock, real helper) */
	bench?: BenchDeps;
	/** how the `net` / `location` verbs open the device, start their detached processes and read the lease's proxy (default: real) */
	conditions?: ConditionsDeps;
	/** pid liveness for the busy-device check (default: `kill(pid, 0)`) */
	pidAlive?: PidAlive;
	/** `open --kind`: install a build kind on the device (default: `ensureAppFor`) */
	ensureApp?: RunEnsureApp;
};

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
 * A driver failure as a `warden ui` error: a locked phone exits 2, engine problems exit 3, a stale ref exits 4, the
 * rest exit 1.
 */
export function driverUiError(error: DriverError): UiError {
	const message = `${error.code}: ${error.message}`;
	if (error.code === "E_STALE_REF") {
		return uiError("stale_ref", error.message, { hint: "run `warden ui snapshot` again" });
	}
	if (error.code === "E_DEVICE_LOCKED") return uiError("device_locked", message, { hint: DEVICE_LOCKED_HINT });
	if (ENGINE_CODES.has(error.code)) return uiError("engine_unavailable", message);
	return uiError("failed", message, { details: { driver: error.code } });
}

/** The real deps. The driver module (engines, zod) is imported when a subcommand first opens a device. */
export const defaultUiDeps: UiDeps = {
	driver: async (ctx, device) => (await import("./ui-driver")).uiDriver(ctx, device),
	sleep: (ms) => Bun.sleep(ms),
};

/** `ok`/`err` helper for driver calls inside `warden ui`: DriverError → UiError. */
export function fromDriver<T>(result: Result<T, DriverError>): Result<T, UiError> {
	return result.success ? ok(result.data) : { success: false, error: driverUiError(result.error) };
}
