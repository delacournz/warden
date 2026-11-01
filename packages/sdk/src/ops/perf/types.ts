import type { Lease } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import type { AsyncResult } from "@delacour/warden-types/result";
import type { UiDeviceInfoJson } from "../../contracts/ui.schema";
import type { PerfEnv } from "./env";
import type { SessionDeps } from "./session";

/**
 * `observe` capturers (metrics, attach-only traces, Metro/Hermes, logs, crashes, frame reads) run on any warden
 * device and never take or heartbeat a lease. `mutate` ones (kill/launch, dumpheap, `gfxinfo reset`, heap
 * snapshots) need the caller's own lease.
 */
export type PerfMode = "observe" | "mutate";

/** Where the device came from. */
export type PerfDeviceSource = "flag" | "WARDEN_UDID" | "WARDEN_UDIDS" | "lease" | "claim" | "booted";

/** The device a perf call acts on. */
export type PerfTarget = UiDeviceInfoJson & {
	/** who holds the device now (live lease), when not the caller */
	holder?: string;
	ownedByCaller: boolean;
	/** the caller's lease, when `mutate` took or kept one */
	lease?: Lease;
	source: PerfDeviceSource;
	mode: PerfMode;
};

/** Host facts a perf step reads that are not a plain `env.exec` call; tests inject fakes. */
export type PerfHostDeps = {
	platform: NodeJS.Platform;
	/** the Metro serving this device (`WARDEN_METRO_URL`, the device's state.json, the owner's leased ports) */
	metro: (env: PerfEnv, udid: string | undefined) => Promise<string | undefined>;
};

/** What the perf engine reaches the outside world through, beyond {@link PerfEnv}. */
export type PerfEngineDeps = {
	session: SessionDeps;
	host: PerfHostDeps;
};

/** What a perf step reports: its typed result and the one-line human rendering (the CLI prints `text`, the SDK returns `result`). */
export type PerfDone<R = unknown> = {
	device: UiDeviceInfoJson;
	result: R;
	/** the human rendering (no trailing newline) */
	text: string;
	warnings?: string[];
	/** non-zero when the step ends early without failing (interrupted: 130) */
	exit?: 0 | 1 | 2 | 3 | 4 | 130;
};

/** A perf step's outcome. */
export type PerfOutcome<R = unknown> = AsyncResult<PerfDone<R>, WardenError>;
