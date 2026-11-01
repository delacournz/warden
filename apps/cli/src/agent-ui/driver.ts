import type { Driver } from "@delacour/warden-driver/driver.types";
import type { RunEnsureApp } from "@delacour/warden-leasing/session";
import type { RecordSink } from "@delacour/warden-sdk/ops/record";
import type { VideoDeps } from "@delacour/warden-sdk/ops/video";
import type { PidAlive } from "@delacour/warden-store/liveness";
import type { Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { AuthoringDeps } from "./authoring-command";
import type { BenchDeps } from "./bench";
import type { ConditionsDeps } from "./conditions-types";
import type { UiDevice } from "./device";
import type { CliDevtoolsDeps } from "./devtools-cli";
import type { UiError } from "./output";

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
	devtools?: CliDevtoolsDeps;
	/** clock and helper/driver plumbing of `bench` (default: wall clock, real helper) */
	bench?: BenchDeps;
	/** how the `net` / `location` verbs open the device, start their detached processes and read the lease's proxy (default: real) */
	conditions?: ConditionsDeps;
	/** pid liveness for the busy-device check (default: `kill(pid, 0)`) */
	pidAlive?: PidAlive;
	/** `open --kind`: install a build kind on the device (default: `ensureAppFor`) */
	ensureApp?: RunEnsureApp;
};

/** The real deps. The driver module (engines, zod) is imported when a subcommand first opens a device. */
export const defaultUiDeps: UiDeps = {
	driver: async (ctx, device) => (await import("./ui-driver")).uiDriver(ctx, device),
	sleep: (ms) => Bun.sleep(ms),
};

/** Driver failures as `warden ui` errors (engine problems exit 3, a stale ref exits 4, the rest exit 1). */
export { DEVICE_LOCKED_HINT, opErrors } from "@delacour/warden-sdk/ops/errors";
