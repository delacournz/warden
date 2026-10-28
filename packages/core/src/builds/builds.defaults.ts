import type { Platform } from "../types";
import type { AppFramework } from "./native-ids";

/** EAS build profile searched when the project config names none. */
export const DEFAULT_EAS_PROFILE = "development-simulator";

/** Xcode / Gradle build configuration the local build produces (`build.configuration`). */
export type BuildConfiguration = "Debug" | "Release";

/**
 * Makes a fresh (CNG) checkout buildable: `expo run:ios --no-install` skips CocoaPods, so generate
 * `ios/` when it has no Podfile and run `pod install` when the Pods sandbox is missing or out of sync
 * with `Podfile.lock` (the check Xcode's own build phase makes). A no-op on a prepared project.
 */
export const IOS_NATIVE_PREPARE =
	"{ [ -f ios/Podfile ] || bunx expo prebuild --platform ios --no-install; } && " +
	"{ diff -q ios/Podfile.lock ios/Pods/Manifest.lock >/dev/null 2>&1 || pod install --project-directory=ios; }";

/**
 * A bare React Native app: CocoaPods when the sandbox is out of sync, then the community CLI's
 * build-only commands. `RCT_NO_LAUNCH_PACKAGER` stops the template's Xcode phase starting its own Metro on 8081.
 */
function reactNativeBuildCommand(platform: Platform, configuration: BuildConfiguration): string {
	const env = "RCT_NO_LAUNCH_PACKAGER=1";
	if (platform === "ios") {
		const pods =
			"{ diff -q ios/Podfile.lock ios/Pods/Manifest.lock >/dev/null 2>&1 || pod install --project-directory=ios; }";
		return `${pods} && ${env} npx react-native build-ios --mode ${configuration}`;
	}
	return `${env} npx react-native build-android --mode ${configuration.toLowerCase()}`;
}

/** Local build command (run in the project root) when `build.<platform>` is not configured. */
export function defaultBuildCommand(
	platform: Platform,
	configuration: BuildConfiguration,
	framework: AppFramework = "expo"
): string {
	if (framework === "react-native") return reactNativeBuildCommand(platform, configuration);
	const flags = "--no-install --no-bundler";
	if (platform === "ios") {
		return `${IOS_NATIVE_PREPARE} && bunx expo run:ios ${configuration === "Release" ? "--configuration Release " : ""}${flags}`;
	}
	return `bunx expo run:android ${configuration === "Release" ? "--variant release " : ""}${flags}`;
}

/** Android twin of `IOS_NATIVE_PREPARE`: generate `android/` when a CNG checkout has none. */
export const ANDROID_NATIVE_PREPARE =
	"{ [ -f android/gradlew ] || bunx expo prebuild --platform android --no-install; }";

/** Gradle's `reactNativeArchitectures` for the host's emulators: arm64 on Apple silicon, else x86_64 (one ABI, not four). */
const ANDROID_HOST_ABI = '"$([ "$(uname -m)" = arm64 ] && echo arm64-v8a || echo x86_64)"';

/**
 * Local build command of the `simulator` kind: the Release configuration for a simulator / emulator; a repack swaps the
 * JS in. iOS: Xcode's bundling phase is skipped with `SKIP_BUNDLING=1`. Android: plain `assembleRelease`. Excluding
 * `createBundleReleaseJsAndAssets` (`-x`) fails on RN 0.86 / AGP 9 ("Querying the mapped value ... before task ... has
 * completed"), and the bundler's `drawable-*` / `raw` images are compiled into the APK's resource table by that task:
 * without them the Android repack finds no image in the base and always falls back to a full build.
 */
export function simulatorBuildCommand(platform: Platform, framework: AppFramework = "expo"): string {
	if (platform === "ios") {
		if (framework === "react-native") {
			const pods =
				"{ diff -q ios/Podfile.lock ios/Pods/Manifest.lock >/dev/null 2>&1 || pod install --project-directory=ios; }";
			return `${pods} && RCT_NO_LAUNCH_PACKAGER=1 SKIP_BUNDLING=1 npx react-native build-ios --mode Release`;
		}
		return `${IOS_NATIVE_PREPARE} && SKIP_BUNDLING=1 bunx expo run:ios --configuration Release --no-install --no-bundler`;
	}
	const gradle = `cd android && ./gradlew app:assembleRelease -PreactNativeArchitectures=${ANDROID_HOST_ABI}`;
	return framework === "react-native" ? gradle : `${ANDROID_NATIVE_PREPARE} && ${gradle}`;
}

/**
 * What a kind's JS key (and a `release` kind's build key) covers when `kinds.<kind>.jsInputs` is not set: every file git
 * tracks (or would) under the project root except the native projects and dependencies. A monorepo workspace package the
 * bundle embeds is not under the root: list it (`../../packages/ui/src/**`) in `jsInputs`.
 */
export const DEFAULT_JS_INPUTS: readonly string[] = [
	"**",
	"!ios/**",
	"!android/**",
	"!node_modules/**",
	"!**/node_modules/**",
];

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
