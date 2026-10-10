/** Default lease TTL for agents/users: 30 min (plan default 2a). */
export const DEFAULT_TTL_MS = 30 * 60_000;
/** Bare `warden claim` by an agent: 5 min. Only wrappers (`dev`/`run`/`batch`/`e2e`) or `heartbeat` hold longer. */
export const BARE_CLAIM_AGENT_TTL_MS = 5 * 60_000;
/** `warden gc` shuts down idle warden devices after 20 min. */
export const DEFAULT_IDLE_MS = 20 * 60_000;
/** `warden run` heartbeat interval. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Device boot/ready timeout. */
export const DEFAULT_READY_TIMEOUT_MS = 5 * 60_000;
/** Default device profile per platform. Android `auto` = first AVD from `emulator -list-avds`. */
export const DEFAULT_PROFILE = { ios: "iphone-17", android: "auto" } as const;

/** Where a warden-owned Metro leases its port from (`warden dev`, `e2e.<suite>.metro`). */
export const DEFAULT_METRO_PORT_SPEC = "8081:100";
/** How long to wait for an owned Metro to serve its project. */
export const DEFAULT_METRO_READY_TIMEOUT = "2m";
/** `e2e.<suite>.jobTimeoutMs`: a runner process still going after this is killed. */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;
