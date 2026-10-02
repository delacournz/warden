/** A warden sim unused (no claim, no boot) this long is deletable by `warden sims prune` (and suggested by `delete`). */
export const DEFAULT_SIM_IDLE_MS = 7 * 24 * 60 * 60_000;
/** A foreign sim not booted this long is suggested by `warden sims delete` (and hinted by `audit`). */
export const DEFAULT_SIM_STALE_MS = 30 * 24 * 60 * 60_000;
