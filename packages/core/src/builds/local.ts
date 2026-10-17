import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { type GitFactsCache, readGitFacts } from "../git-facts";
import { wardenHome as resolveWardenHome } from "../store";
import type { Platform } from "../types";
import type { BuildConfiguration } from "./builds.defaults";
import { LOCAL_BUILD_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "./builds.defaults";
import { compilerCacheEnv, parseXcodeMajor } from "./compiler-cache";
import type { Project } from "./config";
import { type CacheKey, computeCacheKey } from "./fingerprint";
import { combineKey } from "./js-inputs";

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

/** An instrumentation / Detox test APK (`apk/androidTest/…`): never the app. */
function isTestApk(apk: string, outputs: string): boolean {
	return relative(outputs, dirname(apk)).split(sep).includes("androidTest");
}

/**
 * Candidate build outputs for `configuration`: iOS `.app`s in `<root>/ios/build/…/<Config>-iphonesimulator`
 * and the DerivedData projects' `…/<Config>-iphonesimulator` (`derivedProjects`, default every project in
 * `derivedData`); Android `.apk`s under `<root>/android/app/build/outputs/apk` whose variant directory is
 * that configuration (never an `androidTest` APK).
 */
export function artifactCandidates(
	root: string,
	platform: Platform,
	derivedData: string,
	configuration: BuildConfiguration = "Debug",
	derivedProjects: readonly string[] = children(derivedData)
): string[] {
	if (platform === "android") {
		const outputs = join(root, "android", "app", "build", "outputs", "apk");
		return findFiles(outputs, ".apk").filter((apk) => isApkOf(apk, outputs, configuration) && !isTestApk(apk, outputs));
	}
	const products = simProducts(configuration);
	const productDirs = [join(root, "ios", "build", products), ...derivedProjects.map((d) => join(d, products))];
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
	/** the native half of `hash` for a JS-aware project (lets a prebuild-moved native fingerprint be re-keyed) */
	native?: string;
	env: Record<string, string | undefined>;
	/** wall clock (ms) — artifacts older than the build start are ignored */
	now: () => number;
	log: (line: string) => void;
	timeoutMs?: number;
	/** inject ccache / Xcode / Gradle caching env (default true); integrator: pass `project.build.cache !== false` */
	compilerCache?: boolean;
	/** warden home for the shared ccache (default: resolved from `env`) */
	wardenHome?: string;
	/** per-command memo of the git facts (default: a short-lived shared one) */
	git?: GitFactsCache;
};

async function probe(deps: LocalBuildDeps, argv: string[], cwd?: string): Promise<string | undefined> {
	try {
		const res = await deps.exec(argv, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
		return res.exitCode === 0 ? res.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** The project's git toplevel from the facts the command already read; a failed read is no toplevel, never a failed build. */
async function gitToplevel(deps: LocalBuildDeps): Promise<string | undefined> {
	try {
		return (await readGitFacts(deps.exec, deps.project.root, deps.git))?.toplevel;
	} catch {
		return undefined;
	}
}

async function cacheEnv(deps: LocalBuildDeps): Promise<Record<string, string>> {
	if (deps.compilerCache === false) return {};
	const { platform } = deps;
	const gitTop = platform === "ios" ? await gitToplevel(deps) : undefined;
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

/** What a local build produced: the artifact, and the project's key after the build when the build itself moved it (17-1). */
export type LocalBuild = { artifact: string; postKey?: string };

const isInside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}${sep}`);

/** `root` and its real path (`/tmp` vs `/private/tmp`): Xcode records the resolved workspace path. */
function rootForms(root: string): string[] {
	try {
		const real = realpathSync(root);
		return real === root ? [root] : [root, real];
	} catch {
		return [root];
	}
}

/** Workspace / project names under `<root>/ios`: Xcode names a DerivedData dir `<name>-<hash>`. */
function workspaceNames(root: string): string[] {
	return children(join(root, "ios"))
		.map((p) => basename(p))
		.filter((n) => n.endsWith(".xcworkspace") || n.endsWith(".xcodeproj"))
		.map((n) => n.replace(/\.(xcworkspace|xcodeproj)$/, ""));
}

/**
 * The DerivedData projects that build a workspace inside `root` (`info.plist` `WorkspacePath`), so a
 * sibling worktree's build of the same app is never picked. Dirs not named after one of the root's
 * workspaces are skipped without a `plutil`.
 */
async function ownDerivedProjects(deps: LocalBuildDeps, derivedData: string): Promise<string[]> {
	const names = workspaceNames(deps.project.root);
	const named = children(derivedData).filter(
		(d) =>
			names.length === 0 ||
			names.some((n) => basename(d).startsWith(`${n}-`) || basename(d).startsWith(`${n.replaceAll(" ", "_")}-`))
	);
	const roots = rootForms(deps.project.root);
	const owned = await Promise.all(
		named.map(async (d) => {
			const workspace = await probe(deps, [
				"plutil",
				"-extract",
				"WorkspacePath",
				"raw",
				"-o",
				"-",
				join(d, "info.plist"),
			]);
			return workspace !== undefined && roots.some((r) => isInside(workspace, r)) ? d : undefined;
		})
	);
	return owned.filter((d): d is string => d !== undefined);
}

/** iOS: `app`'s `CFBundleIdentifier` against the project's (a UI test runner or another app is a mismatch). */
type BundleCheck = "match" | "mismatch" | "unknown";

async function bundleCheck(deps: LocalBuildDeps, app: string): Promise<BundleCheck> {
	const want = deps.project.bundleId.ios;
	if (deps.platform !== "ios" || !want) return "unknown";
	const id = await probe(deps, ["plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Info.plist")]);
	if (id === undefined || id === "") return "unknown";
	return id === want ? "match" : "mismatch";
}

type Candidate = { path: string; at: number; local: boolean };

/**
 * The build's artifact: the newest output modified since the build start (`<root>/ios/build` before
 * DerivedData). When there is none, the newest older output — an up-to-date Gradle / XCBuild run leaves
 * its artifact untouched (17-2). Only called once the key is verified (unchanged or a prebuild re-key),
 * so the old output was built from these inputs; on iOS it must also carry the project's bundle id (a
 * fresh output is only skipped for a bundle id that reads as another one).
 */
async function findArtifact(deps: LocalBuildDeps, since: number): Promise<string | undefined> {
	const { project, platform } = deps;
	const derivedData = derivedDataDir(deps.env);
	const derived = platform === "ios" ? await ownDerivedProjects(deps, derivedData) : [];
	const candidates: Candidate[] = artifactCandidates(
		project.root,
		platform,
		derivedData,
		project.buildConfiguration,
		derived
	)
		.filter((path) => existsSync(path))
		.map((path) => ({ path, at: mtime(path), local: isInside(path, project.root) }));
	const fresh = candidates
		.filter((c) => c.at >= since)
		.sort((a, b) => Number(b.local) - Number(a.local) || b.at - a.at);
	for (const c of fresh) if ((await bundleCheck(deps, c.path)) !== "mismatch") return c.path;
	const older = candidates.filter((c) => c.at < since).sort((a, b) => b.at - a.at);
	for (const c of older) {
		if (platform === "ios" && (await bundleCheck(deps, c.path)) !== "match") continue;
		deps.log(`using up-to-date artifact ${c.path} (mtime ${new Date(c.at).toISOString()})`);
		return c.path;
	}
	return undefined;
}

/** What the build may legitimately change: the native dir it creates on a fresh checkout. */
type BeforeBuild = { nativeDir: string; nativeDirExisted: boolean; status?: string };

/** `git status` of the whole checkout minus the platform's native dir (native-only projects' mid-build edit check). */
function statusArgv(platform: Platform): string[] {
	return ["git", "status", "--porcelain", "--", ":/", `:(exclude)${platform}`];
}

async function beforeBuild(deps: LocalBuildDeps): Promise<BeforeBuild> {
	const nativeDir = join(deps.project.root, deps.platform);
	const nativeDirExisted = existsSync(nativeDir);
	if (nativeDirExisted || deps.project.jsInputs !== undefined) return { nativeDir, nativeDirExisted };
	const status = await probeRaw(deps, statusArgv(deps.platform), deps.project.root);
	return { nativeDir, nativeDirExisted, ...(status !== undefined ? { status } : {}) };
}

async function probeRaw(deps: LocalBuildDeps, argv: string[], cwd: string): Promise<string | undefined> {
	try {
		const res = await deps.exec(argv, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
		return res.exitCode === 0 ? res.stdout : undefined;
	} catch {
		return undefined;
	}
}

/**
 * May a build whose key moved from `deps.hash` to `after.key` be cached under `deps.hash`? Only when the
 * build created the native dir (expo prebuild on a fresh checkout: CNG output is a function of the
 * pre-build inputs) and nothing else moved: the JS half for a JS-aware project, else `git status`
 * outside the native dir. A native dir that was already there and still changed is a real native edit.
 */
async function prebuildMovedKey(deps: LocalBuildDeps, before: BeforeBuild, after: CacheKey): Promise<boolean> {
	if (before.nativeDirExisted || !existsSync(before.nativeDir)) return false;
	if (deps.project.jsInputs !== undefined) {
		return deps.native !== undefined && after.js !== undefined && combineKey(deps.native, after.js) === deps.hash;
	}
	if (before.status === undefined) return false;
	const now = await probeRaw(deps, statusArgv(deps.platform), deps.project.root);
	return now === before.status;
}

/**
 * Run `build.<platform>` in the project root, locate the produced `.app`/`.apk`, and verify the
 * project's cache key (native fingerprint, plus the JS sources for a JS-aware project) still equals
 * `hash` (a build that changed native inputs — or a source tree edited mid-build — must not be cached
 * under the old hash). The one accepted move: a fresh checkout's prebuild created the native dir
 * (`postKey`, see `prebuildMovedKey`).
 */
export async function runLocalBuild(deps: LocalBuildDeps): AsyncResult<LocalBuild> {
	const { project, platform } = deps;
	const command = project.build[platform];
	const since = deps.now() - 1_000;
	const before = await beforeBuild(deps);
	deps.log(`building ${platform} locally: ${command} (in ${project.root})`);
	const argv = ["sh", "-c", command];
	const caching = await cacheEnv(deps);
	const res = await deps.exec(argv, {
		cwd: project.root,
		env: { ...caching, EXPO_NO_TELEMETRY: "1" },
		timeoutMs: deps.timeoutMs ?? LOCAL_BUILD_TIMEOUT_MS,
	});
	if (res.exitCode !== 0) return err(`local build failed: ${execError(argv, res)}`);
	const after = await computeCacheKey(deps.exec, project, platform);
	if (!after.success) return after;
	const moved = after.data.key !== deps.hash;
	if (moved && !(await prebuildMovedKey(deps, before, after.data))) {
		return err(`fingerprint changed during the build (${deps.hash} → ${after.data.key}); not caching`);
	}
	const artifact = await findArtifact(deps, since);
	if (!artifact) {
		return err(
			`local build succeeded but no ${project.buildConfiguration} ${platform === "ios" ? ".app" : ".apk"} was found (DerivedData / android/app/build/outputs)`
		);
	}
	if (moved)
		deps.log(`the build created ${platform}/ (prebuild): caching under ${deps.hash}, aliased as ${after.data.key}`);
	return ok(moved ? { artifact, postKey: after.data.key } : { artifact });
}
