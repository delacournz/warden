import type { Platform } from "../types";

/** EAS build profile searched when the project config names none. */
export const DEFAULT_EAS_PROFILE = "development-simulator";

/** Xcode / Gradle build configuration the local build produces (`build.configuration`). */
export type BuildConfiguration = "Debug" | "Release";

/** Local build command (run in the project root) when `build.<platform>` is not configured. */
export function defaultBuildCommand(platform: Platform, configuration: BuildConfiguration): string {
	const flags = "--no-install --no-bundler";
	if (platform === "ios") {
		return `bunx expo run:ios ${configuration === "Release" ? "--configuration Release " : ""}${flags}`;
	}
	return `bunx expo run:android ${configuration === "Release" ? "--variant release " : ""}${flags}`;
}

/** The Debug defaults. */
export const DEFAULT_BUILD_COMMAND: Record<Platform, string> = {
	ios: defaultBuildCommand("ios", "Debug"),
	android: defaultBuildCommand("android", "Debug"),
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

/** ccache sloppiness for Xcode/clang builds: lets worktrees with different mtimes/PCH state still hit. */
export const CCACHE_SLOPPINESS =
	"clang_index_store,file_stat_matches,include_file_ctime,include_file_mtime,ivfsoverlay,pch_defines,modules,system_headers,time_macros";
/** Subdirectory of WARDEN_HOME holding the shared ccache. */
export const CCACHE_DIR_NAME = "ccache";
/** First Xcode major with compilation caching (`COMPILATION_CACHE_ENABLE_CACHING`). */
export const XCODE_COMPILATION_CACHE_MIN_MAJOR = 26;
/** Timeout for the quick `git` / `xcodebuild -version` probes before a build. */
export const PROBE_TIMEOUT_MS = 10_000;
