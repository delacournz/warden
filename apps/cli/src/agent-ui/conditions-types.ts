import type { OwnedProcess } from "@delacour/warden-core/conditions/conditions.types";
import type { ProxyStatus } from "@delacour/warden-core/netproxy/control";
import type { Lease } from "@delacour/warden-core/types";
import type { TickerConfig } from "@delacour/warden-e2e/conditions/route-ticker";
import type { SchedulerConfig } from "@delacour/warden-e2e/conditions/scheduler.config";
import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import type { Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import type { UiError } from "./output";

/** The slice of a driver `warden ui net` / `location` use; `close` only disconnects. */
export type ConditionsPort = Pick<Driver, "network" | "networkFaults" | "location" | "clock"> & {
	close(): Promise<void>;
};

/** Everything impure the condition verbs reach; tests inject fakes, the real ones load on first use. */
export type ConditionsDeps = {
	/**
	 * The device's condition port. iOS: the helper's driver with the lease's shaping proxy; Android: adb network
	 * (+ the proxy for loss and faults) and `geo fix` for a point. Route kinds on Android are the ticker's job.
	 */
	open?: (ctx: CommandContext, device: UiDevice) => Promise<Result<ConditionsPort, UiError>>;
	/** start the detached flap scheduler (a compiled warden runs its `__scheduler`) */
	spawnScheduler?: (config: SchedulerConfig) => Result<OwnedProcess>;
	/** start the detached Android route ticker (a compiled warden runs its `__route-ticker`) */
	spawnTicker?: (config: TickerConfig) => Result<OwnedProcess>;
	/** SIGTERM a process (default `process.kill`) */
	kill?: (pid: number) => void;
	/** the lease's shaping proxy as it answers now; undefined when none is up */
	proxyStatus?: (ctx: CommandContext, leaseId: string) => Promise<(ProxyStatus & { port: number }) | undefined>;
	/** the lease's proxy pid from its handle file, when that process is alive */
	proxyPid?: (ctx: CommandContext, leaseId: string) => number | undefined;
	/** a pid's command line, to avoid signalling a reused pid (default `ps`) */
	command?: (pid: number) => string | undefined;
	/** the `adb` binary for an Android device (default: `androidTools(ctx.env).adb`) */
	adb?: (ctx: CommandContext) => string;
	/** make sure the lease has a shaping proxy up (iOS flaps: the detached scheduler then reconfigures it instead of starting one) */
	ensureProxy?: (ctx: CommandContext, lease: Lease) => Promise<Result<void, string>>;
};
