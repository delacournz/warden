import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { wardenHome as resolveWardenHome } from "../store";
import type { Platform } from "../types";
import type { BuildConfiguration } from "./builds.defaults";
import { LOCAL_BUILD_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "./builds.defaults";
import { compilerCacheEnv, parseXcodeMajor } from "./compiler-cache";
import type { Project } from "./config";
import { computeCacheKey } from "./fingerprint";

const simProducts = (configuration: BuildConfiguration) =>
	join("Build", "Products", `${configuration}-iphonesimulator`);

function children(dir: string): string[] {
	try {
		return readdirSync(dir).map((n) => join(dir, n));
	} catch {
		return [];
	}
}

function mtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Recursively collect files ending in `ext` under `dir` (bounded depth). */
function findFiles(dir: string, ext: string, depth = 6): string[] {
	if (depth < 0) return [];
	return children(dir).flatMap((p) => {
		if (p.endsWith(ext)) return [p];
		try {
			return statSync(p).isDirectory() ? findFiles(p, ext, depth - 1) : [];
		} catch {
			return [];
		}
	});
}

/** Is `apk` a build of `configuration`? (`apk/release/…`, `apk/<flavor>/release/…`, `apk/fooRelease/…`) */
function isApkOf(apk: string, outputs: string, configuration: BuildConfiguration): boolean {
	const want = configuration.toLowerCase();
	return relative(outputs, dirname(apk))
		.split(sep)
		.some((segment) => segment.toLowerCase().endsWith(want));
}

/**
 * Candidate build outputs for `configuration`: iOS `.app`s in `<root>/ios/build/…/<Config>-iphonesimulator`
 * and every DerivedData project's `…/<Config>-iphonesimulator`; Android `.apk`s under
 * `<root>/android/app/build/outputs/apk` whose variant directory is that configuration.
 */
export function artifactCandidates(
	root: string,
	platform: Platform,
	derivedData: string,
	configuration: BuildConfiguration = "Debug"
): string[] {
	if (platform === "android") {
		const outputs = join(root, "android", "app", "build", "outputs", "apk");
		return findFiles(outputs, ".apk").filter((apk) => isApkOf(apk, outputs, configuration));
	}
	const products = simProducts(configuration);
	const productDirs = [join(root, "ios", "build", products), ...children(derivedData).map((d) => join(d, products))];
	return productDirs.flatMap((d) => children(d).filter((p) => p.endsWith(".app")));
}

/** Newest candidate modified at/after `since` (the build start). */
export function locateArtifact(
	root: string,
	platform: Platform,
	derivedData: string,
	since: number,
	configuration: BuildConfiguration = "Debug"
): string | undefined {
	return artifactCandidates(root, platform, derivedData, configuration)
		.map((path) => ({ path, at: mtime(path) }))
		.filter((c) => c.at >= since)
		.sort((a, b) => b.at - a.at)[0]?.path;
}

export function derivedDataDir(env: Record<string, string | undefined>): string {
	return join(env.HOME ?? "~", "Library", "Developer", "Xcode", "DerivedData");
}

export type LocalBuildDeps = {
	exec: Exec;
	project: Project;
	platform: Platform;
	hash: string;
	env: Record<string, string | undefined>;
	/** wall clock (ms) — artifacts older than the build start are ignored */
	now: () => number;
	log: (line: string) => void;
	timeoutMs?: number;
	/** inject ccache / Xcode / Gradle caching env (default true); integrator: pass `project.build.cache !== false` */
	compilerCache?: boolean;
	/** warden home for the shared ccache (default: resolved from `env`) */
	wardenHome?: string;
};

async function probe(deps: LocalBuildDeps, argv: string[], cwd?: string): Promise<string | undefined> {
	try {
		const res = await deps.exec(argv, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
		return res.exitCode === 0 ? res.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

async function cacheEnv(deps: LocalBuildDeps): Promise<Record<string, string>> {
	if (deps.compilerCache === false) return {};
	const { platform, project } = deps;
	const gitTop =
		platform === "ios" ? await probe(deps, ["git", "rev-parse", "--show-toplevel"], project.root) : undefined;
	const xcode = platform === "ios" ? await probe(deps, ["xcodebuild", "-version"]) : undefined;
	return compilerCacheEnv({
		platform,
		wardenHome: deps.wardenHome ?? resolveWardenHome(deps.env),
		gitTop: gitTop || undefined,
		xcodeMajor: xcode ? parseXcodeMajor(xcode) : undefined,
		enabled: true,
		baseEnv: deps.env,
	});
}

/**
 * Run `build.<platform>` in the project root, locate the produced `.app`/`.apk`, and verify the
 * project's cache key (native fingerprint, plus the JS sources for a JS-aware project) still equals
 * `hash` (a build that changed native inputs — or a source tree edited mid-build — must not be cached
 * under the old hash).
 */
export async function runLocalBuild(deps: LocalBuildDeps): AsyncResult<string> {
	const { project, platform } = deps;
	const command = project.build[platform];
	const since = deps.now() - 1_000;
	deps.log(`building ${platform} locally: ${command} (in ${project.root})`);
	const argv = ["sh", "-c", command];
	const caching = await cacheEnv(deps);
	const res = await deps.exec(argv, {
		cwd: project.root,
		env: { ...caching, EXPO_NO_TELEMETRY: "1" },
		timeoutMs: deps.timeoutMs ?? LOCAL_BUILD_TIMEOUT_MS,
	});
	if (res.exitCode !== 0) return err(`local build failed: ${execError(argv, res)}`);
	const artifact = locateArtifact(project.root, platform, derivedDataDir(deps.env), since, project.buildConfiguration);
	if (!artifact || !existsSync(artifact)) {
		return err(
			`local build succeeded but no ${project.buildConfiguration} ${platform === "ios" ? ".app" : ".apk"} was found (DerivedData / android/app/build/outputs)`
		);
	}
	const after = await computeCacheKey(deps.exec, project, platform);
	if (!after.success) return after;
	if (after.data.key !== deps.hash) {
		return err(`fingerprint changed during the build (${deps.hash} → ${after.data.key}); not caching ${artifact}`);
	}
	return ok(artifact);
}
