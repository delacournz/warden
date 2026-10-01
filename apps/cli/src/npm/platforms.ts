import { err, ok, type Result } from "@delacour/warden-types/result";

/** The published npm package; its `warden` bin is a JS shim that runs the matching platform package's binary. */
export const NPM_PACKAGE = "@delacour/warden";

/** Every `bun build --compile` target shipped as a GitHub release asset and an npm platform package. */
export const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

function isReleaseTarget(value: string): value is ReleaseTarget {
	return RELEASE_TARGETS.some((target) => target === value);
}

/** `process.platform` + `process.arch` → release target, e.g. `darwin` + `arm64` → `darwin-arm64`. */
export function releaseTarget(platform: string, arch: string): Result<ReleaseTarget> {
	const target = `${platform}-${arch}`;
	return isReleaseTarget(target)
		? ok(target)
		: err(`no warden build for ${target} (supported: ${RELEASE_TARGETS.join(", ")})`);
}

/** `darwin-arm64` → `@delacour/warden-darwin-arm64`. */
export function platformPackageName(target: ReleaseTarget): string {
	return `${NPM_PACKAGE}-${target}`;
}
