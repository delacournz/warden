import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { type GitFactsCache, readGitFacts } from "../git-facts";
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

/** Every candidate's mtime, taken just before the build runs. */
export type ArtifactSnapshot = ReadonlyMap<string, number>;

export function snapshotArtifacts(
	root: string,
	platform: Platform,
	derivedData: string,
	configuration: BuildConfiguration = "Debug"
): ArtifactSnapshot {
	return new Map(artifactCandidates(root, platform, derivedData, configuration).map((p) => [p, mtime(p)]));
}

/**
 * `rebuilt`: new or rewritten during the build. `up-to-date`: the build left this project's only
 * matching output in place. `ambiguous`: it left several, so none can be told apart from a stale one.
 */
export type LocatedArtifact =
	| { kind: "rebuilt"; path: string }
	| { kind: "up-to-date"; path: string }
	| { kind: "ambiguous"; paths: string[] };

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function samePath(a: string, b: string): boolean {
	return a === b || real(a) === real(b);
}

function isInside(path: string, root: string): boolean {
	const rel = relative(real(root), real(path));
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Xcode records the workspace a DerivedData dir belongs to in its `info.plist` (`WorkspacePath`). */
function derivedDataWorkspace(projectDir: string): string | undefined {
	try {
		const plist = readFileSync(join(projectDir, "info.plist"), "utf8");
		const raw = /<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
		return raw?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? "");
	} catch {
		return undefined;
	}
}

/**
 * Is `artifact` this project's own output? Android apks and `ios/build` live under the root; a
 * DerivedData product only when its project dir's `WorkspacePath` sits in `<root>/ios` (never
 * another checkout or worktree of the same app, nested or not).
 */
function ownedBy(artifact: string, root: string, derivedData: string): boolean {
	if (isInside(artifact, root)) return true;
	const [projectDir] = relative(derivedData, artifact).split(sep);
	if (!projectDir || projectDir.startsWith("..")) return false;
	const workspace = derivedDataWorkspace(join(derivedData, projectDir));
	return workspace !== undefined && samePath(dirname(workspace), join(root, "ios"));
}

/**
 * The artifact a successful build produced, vs the `before` snapshot: the newest of this project's
 * candidates it created or rewrote; else, for an up-to-date build (Gradle / xcodebuild skipped every
 * task), this project's single unchanged candidate; else the newest rewritten candidate of unknown
 * owner (a workspace outside `<root>/ios`).
 */
export function locateArtifact(
	root: string,
	platform: Platform,
	derivedData: string,
	before: ArtifactSnapshot,
	configuration: BuildConfiguration = "Debug"
): LocatedArtifact | undefined {
	const candidates = artifactCandidates(root, platform, derivedData, configuration)
		.map((path) => ({ path, at: mtime(path), owned: ownedBy(path, root, derivedData) }))
		.filter((c) => c.at > 0)
		.sort((a, b) => b.at - a.at);
	const changed = candidates.filter((c) => before.get(c.path) !== c.at);
	const ownChanged = changed.find((c) => c.owned);
	if (ownChanged) return { kind: "rebuilt", path: ownChanged.path };
	const kept = candidates.filter((c) => c.owned && before.get(c.path) === c.at);
	if (kept.length > 1) return { kind: "ambiguous", paths: kept.map((c) => c.path) };
	if (kept[0]) return { kind: "up-to-date", path: kept[0].path };
	return changed[0] ? { kind: "rebuilt", path: changed[0].path } : undefined;
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

/**
 * Run `build.<platform>` in the project root, locate the produced `.app`/`.apk`, and verify the
 * project's cache key (native fingerprint, plus the JS sources for a JS-aware project) still equals
 * `hash` (a build that changed native inputs — or a source tree edited mid-build — must not be cached
 * under the old hash).
 */
export async function runLocalBuild(deps: LocalBuildDeps): AsyncResult<string> {
	const { project, platform } = deps;
	const command = project.build[platform];
	const derivedData = derivedDataDir(deps.env);
	const before = snapshotArtifacts(project.root, platform, derivedData, project.buildConfiguration);
	deps.log(`building ${platform} locally: ${command} (in ${project.root})`);
	const argv = ["sh", "-c", command];
	const caching = await cacheEnv(deps);
	const res = await deps.exec(argv, {
		cwd: project.root,
		env: { ...caching, EXPO_NO_TELEMETRY: "1" },
		timeoutMs: deps.timeoutMs ?? LOCAL_BUILD_TIMEOUT_MS,
	});
	if (res.exitCode !== 0) return err(`local build failed: ${execError(argv, res)}`);
	const located = locateArtifact(project.root, platform, derivedData, before, project.buildConfiguration);
	const kind = `${project.buildConfiguration} ${platform === "ios" ? ".app" : ".apk"}`;
	if (located?.kind === "ambiguous") {
		return err(
			`local build was up to date but left ${located.paths.length} ${kind}s, any of which could be stale: ${located.paths.join(", ")}; delete the ones this build should not produce and retry`
		);
	}
	if (!located || !existsSync(located.path)) {
		return err(`local build succeeded but no ${kind} was found (DerivedData / android/app/build/outputs)`);
	}
	const artifact = located.path;
	if (located.kind === "up-to-date") deps.log(`build was up to date; reusing ${artifact}`);
	const after = await computeCacheKey(deps.exec, project, platform);
	if (!after.success) return after;
	if (after.data.key !== deps.hash) {
		return err(`fingerprint changed during the build (${deps.hash} → ${after.data.key}); not caching ${artifact}`);
	}
	return ok(artifact);
}
