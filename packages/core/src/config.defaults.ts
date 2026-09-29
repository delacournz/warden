/** Default lease TTL for agents/users: 30 min (plan default 2a). */
export const DEFAULT_TTL_MS = 30 * 60_000;
/** `warden gc` shuts down idle warden devices after 20 min. */
export const DEFAULT_IDLE_MS = 20 * 60_000;
/** `warden run` heartbeat interval. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Device boot/ready timeout. */
export const DEFAULT_READY_TIMEOUT_MS = 5 * 60_000;
/** Default device profile per platform. Android `auto` = first AVD from `emulator -list-avds`. */
export const DEFAULT_PROFILE = { ios: "iphone-17", android: "auto" } as const;
