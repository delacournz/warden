import type { Exec } from "@delacour/warden-runtime/exec";
import type { Platform } from "@delacour/warden-store/types";
import {
	CCACHE_DIR_NAME,
	CCACHE_SLOPPINESS,
	PROBE_TIMEOUT_MS,
	XCODE_COMPILATION_CACHE_MIN_MAJOR,
} from "./builds.defaults";

export type CompilerCacheInput = {
	platform: Platform;
	wardenHome: string;
	/** `git rev-parse --show-toplevel` of the project; makes ccache paths worktree-relative */
	gitTop: string | undefined;
	/** `undefined` = unknown / not installed */
	xcodeMajor: number | undefined;
	enabled: boolean;
	/** caller env, to preserve `GRADLE_OPTS` */
	baseEnv?: Record<string, string | undefined>;
};

/** Compiler-cache env and probes for native builds. Pure; `exec` is passed per call. */
export class CompilerCache {
	/**
	 * Env vars that make native cache-miss builds share compiler output across git worktrees:
	 * ccache (+ Xcode 26 compilation cache) for iOS, Gradle build cache for Android. `{}` when disabled.
	 */
	env(input: CompilerCacheInput): Record<string, string> {
		if (!input.enabled) return {};
		if (input.platform === "android") {
			const existing = input.baseEnv?.GRADLE_OPTS?.trim();
			return { GRADLE_OPTS: [existing, "-Dorg.gradle.caching=true"].filter(Boolean).join(" ") };
		}
		return {
			USE_CCACHE: "1",
			CCACHE_DIR: `${input.wardenHome}/${CCACHE_DIR_NAME}`,
			...(input.gitTop ? { CCACHE_BASEDIR: input.gitTop } : {}),
			CCACHE_SLOPPINESS,
			CCACHE_FILECLONE: "true",
			CCACHE_NOHASHDIR: "true",
			...(input.xcodeMajor !== undefined && input.xcodeMajor >= XCODE_COMPILATION_CACHE_MIN_MAJOR
				? { COMPILATION_CACHE_ENABLE_CACHING: "YES" }
				: {}),
		};
	}

	/** `Xcode 26.0.1\nBuild version …` → 26. */
	parseXcodeMajor(stdout: string): number | undefined {
		const match = /^Xcode\s+(\d+)/m.exec(stdout);
		return match?.[1] ? Number(match[1]) : undefined;
	}

	/** `ccache --cleanup` on warden's shared cache dir (honours ccache's own max size). Best effort: never throws. */
	async ccacheCleanup(exec: Exec, wardenHome: string): Promise<boolean> {
		try {
			const res = await exec(["ccache", "--cleanup"], {
				env: { CCACHE_DIR: `${wardenHome}/${CCACHE_DIR_NAME}` },
				timeoutMs: PROBE_TIMEOUT_MS * 6,
			});
			return res.exitCode === 0;
		} catch {
			return false;
		}
	}
}

export const compilerCache = new CompilerCache();
