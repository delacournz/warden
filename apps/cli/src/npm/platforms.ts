import { type Result, resultFactory } from "@delacour/warden-types/result";

/** The published npm package; its `warden` bin is a JS shim that runs the matching platform package's binary. */
export const NPM_PACKAGE = "@delacour/warden";

/** `warden e2e`'s spec API (`test`, `expect`, the preload), published in lock-step with `@delacour/warden`. */
export const E2E_PACKAGE = "@delacour/warden-e2e";

/** `createWardenClient` and friends, published in lock-step with `@delacour/warden`. */
export const SDK_PACKAGE = "@delacour/warden-sdk";

/** Every `bun build --compile` target shipped as a GitHub release asset and an npm platform package. */
export const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export class NpmPlatforms {
	private isReleaseTarget(value: string): value is ReleaseTarget {
		return RELEASE_TARGETS.some((target) => target === value);
	}

	/** `process.platform` + `process.arch` → release target, e.g. `darwin` + `arm64` → `darwin-arm64`. */
	releaseTarget(platform: string, arch: string): Result<ReleaseTarget> {
		const target = `${platform}-${arch}`;
		return this.isReleaseTarget(target)
			? resultFactory.ok(target)
			: resultFactory.err(`no warden build for ${target} (supported: ${RELEASE_TARGETS.join(", ")})`);
	}

	/** `darwin-arm64` → `@delacour/warden-darwin-arm64`. */
	platformPackageName(target: ReleaseTarget): string {
		return `${NPM_PACKAGE}-${target}`;
	}
}

export const npmPlatforms = new NpmPlatforms();
