import type { Platform } from "../types";

/** EAS build profile searched when the project config names none. */
export const DEFAULT_EAS_PROFILE = "development-simulator";

/** Local build commands (run in the project root) when `build.<platform>` is not configured. */
export const DEFAULT_BUILD_COMMAND: Record<Platform, string> = {
	ios: "bunx expo run:ios --no-install --no-bundler",
	android: "bunx expo run:android --no-install --no-bundler",
};

/** `warden prune` default budget. */
export const DEFAULT_MAX_CACHE_SIZE = "20G";

/** EAS poll interval while a build for the hash is in flight. */
export const EAS_POLL_MS = 30_000;
/** Give up waiting on EAS after this long (then fall through to a local build). */
export const EAS_TIMEOUT_MS = 45 * 60_000;
/** With `eas.trigger`, wait this long for a build to appear before triggering the workflow. */
export const EAS_TRIGGER_GRACE_MS = 3 * 60_000;

/** Local native build timeout. */
export const LOCAL_BUILD_TIMEOUT_MS = 60 * 60_000;
/** Fingerprint command timeout. */
export const FINGERPRINT_TIMEOUT_MS = 5 * 60_000;

/** Build-lock lease ttl; the lease also carries the holder's pid so it lives as long as the process. */
export const BUILD_LOCK_TTL_MS = 2 * 60_000;
/** How long a resolver waits for another process's build/download of the same hash. */
export const BUILD_LOCK_WAIT_MS = 90 * 60_000;
export const BUILD_LOCK_POLL_MS = 2_000;

/**
 * Pre-warden cache roots (`<dir>/<hash>/*.app|*.apk`) by project name, used when the project config
 * sets no `cacheDirs`. Builds found there are copied into the warden cache on first use.
 */
export const LEGACY_CACHE_DIRS: Readonly<Record<string, readonly string[]>> = {
	salient: ["~/.cache/salient-dev-builds"],
};
