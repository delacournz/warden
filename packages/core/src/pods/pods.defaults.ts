/** Prefix of the key's hash input: bump it to invalidate every entry when the key's meaning changes. */
export const PODS_KEY_VERSION = "pods-v1";

/** `Pods/.warden-pods-key`: the key the sandbox was last installed / restored at. */
export const PODS_STAMP_FILE = ".warden-pods-key";

/** Env a Podfile / podspec may read; part of the key with its value. */
export const PODS_ENV_NAMES: readonly string[] = ["USE_FRAMEWORKS", "USE_CCACHE", "NO_FLIPPER", "RCT_NEW_ARCH_ENABLED"];
export const PODS_ENV_PREFIXES: readonly string[] = ["RCT_", "EX_DEV_CLIENT_", "EXPO_USE_"];

/** Tracked `ios/` files `pod install` rewrites: the key uses their git blob, not their working-tree bytes. */
export const PODS_MUTATED_BY_INSTALL =
	/(^|\/)(Podfile\.lock|[^/]*\.pbxproj|Info\.plist|PrivacyInfo\.xcprivacy)$|\.xcworkspace\//;

/** Dirs under `node_modules` never captured as a pod install write. */
export const PODS_SNAPSHOT_EXCLUDE_DIRS: readonly string[] = [".cache", ".git"];

/** Same as `IOS_NATIVE_PREPARE`'s prebuild step. */
export const PODS_PREBUILD_ARGV: readonly string[] = ["bunx", "expo", "prebuild", "--platform", "ios", "--no-install"];

export const POD_INSTALL_TIMEOUT_MS = 30 * 60_000;
export const PODS_PROBE_TIMEOUT_MS = 60_000;

export const POD_MISSING_HINT = "CocoaPods not found: gem install cocoapods (or brew install cocoapods)";

/** Local podspecs whose JSON holds the root: their sha1 is the lockfile checksum. */
export const LOCAL_PODSPEC_PATH = /\/Pods\/Local Podspecs\/[^/]+\.podspec(\.json)?$/;
