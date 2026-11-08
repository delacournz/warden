import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";

/** The cache-key prefix the e2e action uses; bump it to throw every cache away. */
export const DEFAULT_CACHE_PREFIX = "warden-e2e-v1";

/** Git pathspecs (relative to the project) whose content is the JS bundle's input: the repack cache's key. */
export const DEFAULT_JS_INPUTS: readonly string[] = [
	"src",
	"assets",
	"app.config.ts",
	"index.ts",
	"metro.config.js",
	"package.json",
];

/** Directories a CI cache stores as they are. A `!` path is excluded from the one before it (`actions/cache` syntax). */
export type PathsGroup = { kind: "paths"; key: string; paths: string[] };

/** A directory warden archives into and registers from: run `beforeSave` before storing it, `afterRestore` after. */
export type ArchiveGroup = { kind: "archive"; key: string; paths: string[]; afterRestore: string; beforeSave: string };

export type CacheGroup = PathsGroup | ArchiveGroup;

/**
 * What a CI job caches between runs to skip warden's slow steps: `builds` (the native simulator base), `repack` (the
 * JS bundled into it) and `golden` (the first-booted simulator new devices are cloned from).
 */
export type CacheGroups = { builds: PathsGroup; repack: PathsGroup; golden: ArchiveGroup };

export type CacheGroupsInput = {
	prefix: string;
	/** `<os>-<arch>` of the runner: caches never cross machines that cannot use each other's builds */
	runner: string;
	/** the simulator kind's native fingerprint (`warden app fingerprint ios --kind simulator`) */
	nativeFingerprint: string;
	/** `jsInputsHash` */
	js: string;
	/** the golden's name (`warden golden key`) */
	golden: string;
	wardenHome: string;
	goldenDir: string;
	/** the device profile the golden is for; absent = warden's default */
	profile?: string;
};

const REPACKS = join("*", "ios", "*", "simulator", "repacks");

export function cacheGroups(input: CacheGroupsInput): CacheGroups {
	const { prefix, runner, nativeFingerprint, js, golden, wardenHome, goldenDir, profile } = input;
	const builds = join(wardenHome, "builds");
	const repacks = join(builds, REPACKS);
	const dir = shellQuote(goldenDir);
	const profileArgs = profile === undefined ? "" : ` --profile ${shellQuote(profile)}`;
	return {
		builds: { kind: "paths", key: `${prefix}-builds-${runner}-${nativeFingerprint}`, paths: [builds, `!${repacks}`] },
		repack: { kind: "paths", key: `${prefix}-repack-${runner}-${nativeFingerprint}-${js}`, paths: [repacks] },
		golden: {
			kind: "archive",
			key: `${prefix}-${runner}-${golden}`,
			paths: [goldenDir],
			afterRestore: `warden golden import ${dir}`,
			beforeSave: `warden golden export ${dir} --allow-unsettled${profileArgs}`,
		},
	};
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** GitHub's `RUNNER_OS-RUNNER_ARCH` when both are set (`macOS-ARM64`), else the host spelled the same way. */
export function runnerTag(env: Record<string, string | undefined>, platform: NodeJS.Platform, arch: string): string {
	if (env.RUNNER_OS && env.RUNNER_ARCH) return `${env.RUNNER_OS}-${env.RUNNER_ARCH}`;
	return `${OS_NAMES[platform] ?? platform}-${arch.toUpperCase()}`;
}

/** The first 16 hex chars of the sha256 of `git ls-files -s -- <specs>` run in `cwd`: the staged content of the JS inputs. */
export async function jsInputsHash(exec: Exec, cwd: string, specs: readonly string[]): AsyncResult<string> {
	const listed = await exec(["git", "ls-files", "-s", "--", ...specs], { cwd });
	if (listed.exitCode !== 0) {
		return err(`git ls-files in ${cwd} failed: ${listed.stderr.trim() || `exit ${listed.exitCode}`}`);
	}
	return ok(createHash("sha256").update(listed.stdout).digest("hex").slice(0, 16));
}

/** `value` as one POSIX shell word. */
function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
