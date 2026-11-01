import type { Driver } from "@delacour/warden-driver/driver.types";
import type { Platform } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import type { WardenHost } from "@delacour/warden-types/host";
import type { AsyncResult, Result } from "@delacour/warden-types/result";
import type { AuthoringDeps } from "./authoring/deps";
import type { DevtoolsDeps } from "./devtools";
import type { RecordSink } from "./record";
import type { RefStore } from "./ref-store";
import type { StateStore } from "./state-store";
import type { VideoDeps } from "./video";

/** The side effects an op may use: the {@link WardenHost} subset every op needs. */
export type OpHost = Pick<WardenHost, "env" | "cwd" | "home" | "now" | "exec" | "sleep" | "log">;

/** The device an op acts on. */
export type OpDevice = { id: string; platform: Platform; name?: string };

/**
 * Everything one op call needs about one device. Ops never read globals: the driver opens lazily (so a call that
 * never touches the screen never needs an engine), refs and device state sit behind stores, and every process or
 * clock goes through `host`.
 */
export type OpSession = {
	device: OpDevice;
	host: OpHost;
	/** the device's driver, opened on first use; the caller closes it */
	driver: () => Promise<Result<Driver, WardenError>>;
	refs: RefStore;
	state: StateStore;
	/** per-call deadline for ops that poll (`wait`, `fill` read-back, devtools) */
	timeoutMs: number;
	/** where finished actions are appended (a spec authoring journal); absent = nothing is recorded */
	recorder?: RecordSink;
	/**
	 * The route the app is on after `action`, when it changed (best effort: `undefined` is "unknown", never an error).
	 * Only asked while a `recorder` is set, so a call without one never pays for the read.
	 */
	routeAfter?: (action: string) => Promise<string | undefined>;
	/** how `video start|stop` runs the recorder process (default: real processes) */
	video?: VideoDeps;
	/** how the authoring ops find the suite and verify a recorded spec (defaults: the suite config, no spec runner) */
	authoring?: AuthoringDeps;
	/** how the devtools ops reach Metro and spawn the log collector (required by those ops) */
	devtools?: DevtoolsDeps;
	/** ports leased to this device's owner (Metro discovery for devtools) */
	ports?: () => readonly number[];
};

/** What an op reports: its typed result, the one-line human rendering, and the usual extras. */
export type OpDone<R> = {
	result: R;
	/** the human rendering (no trailing newline) */
	text: string;
	/** the ref generation the call produced, when it took a snapshot */
	generation?: number;
	warnings?: string[];
	/** non-zero when the op answers "no" without failing (`is`) */
	exit?: 1;
};

/** The return type of every op. */
export type OpOutcome<R> = AsyncResult<OpDone<R>, WardenError>;
