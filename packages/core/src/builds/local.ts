import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, type ExecResult, execError } from "../exec";
import { type GitFactsCache, readGitFacts } from "../git-facts";
import { wardenHome as resolveWardenHome } from "../store";
import type { Platform } from "../types";
import { readXcode } from "../xcode";
import type { BuildConfiguration } from "./builds.defaults";
import { LOCAL_BUILD_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "./builds.defaults";
import { compilerCacheEnv } from "./compiler-cache";
import type { Project } from "./config";
import { formatBuildFailure, parseBuildDiagnostics } from "./diagnostics";
import { type CacheKey, computeCacheKey } from "./fingerprint";
import { combineKey, readFileOrUndefined } from "./js-inputs";
import type { BuildTarget } from "./kinds";
import { planPrebuiltRn } from "./prebuilt-rn";

const iosProducts = (configuration: BuildConfiguration, target: BuildTarget) =>
	join("Build", "Products", `${configuration}-${target === "device" ? "iphoneos" : "iphonesimulator"}`);

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
 * and every DerivedData project's `…/<Config>-iphonesimulator` (`-iphoneos` for a `device` target); Android `.apk`s under
 * `<root>/android/app/build/outputs/apk` whose variant directory is that configuration (never an
 * `androidTest` APK).
 */
export function artifactCandidates(
	root: string,
	platform: Platform,
	derivedData: string,
	configuration: BuildConfiguration = "Debug",
	target: BuildTarget = "simulator"
): string[] {
	if (platform === "android") {
		const outputs = join(root, "android", "app", "build", "outputs", "apk");
		return findFiles(outputs, ".apk").filter((apk) => isApkOf(apk, outputs, configuration) && !isTestApk(apk, outputs));
	}
	const products = iosProducts(configuration, target);
	const productDirs = [join(root, "ios", "build", products), ...children(derivedData).map((d) => join(d, products))];
	return productDirs.flatMap((d) => children(d).filter((p) => p.endsWith(".app")));
}

/** Every candidate's mtime, taken just before the build runs. */
export type ArtifactSnapshot = ReadonlyMap<string, number>;

export function snapshotArtifacts(
	root: string,
	platform: Platform,
	derivedData: string,
	configuration: BuildConfiguration = "Debug",
	target: BuildTarget = "simulator"
): ArtifactSnapshot {
	return new Map(artifactCandidates(root, platform, derivedData, configuration, target).map((p) => [p, mtime(p)]));
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
 * owner (a workspace outside `<root>/ios`). `exclude`: candidates already ruled out (another bundle id).
 */
export function locateArtifact(
	root: string,
	platform: Platform,
	derivedData: string,
	before: ArtifactSnapshot,
	configuration: BuildConfiguration = "Debug",
	exclude: ReadonlySet<string> = new Set(),
	target: BuildTarget = "simulator"
): LocatedArtifact | undefined {
	const candidates = artifactCandidates(root, platform, derivedData, configuration, target)
		.filter((path) => !exclude.has(path))
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
	/** the native half of `hash` for a JS-aware project (lets a prebuild-moved native fingerprint be re-keyed) */
	native?: string;
	env: Record<string, string | undefined>;
	log: (line: string) => void;
	/** the build command's own output, line by line, while it runs (default: kept for the failure summary only) */
	output?: (line: string) => void;
	timeoutMs?: number;
	/** inject ccache / Xcode / Gradle caching env (default true); integrator: pass `project.build.cache !== false` */
	compilerCache?: boolean;
	/** warden home for the shared ccache (default: resolved from `env`) */
	wardenHome?: string;
	/** per-command memo of the git facts (default: a short-lived shared one) */
	git?: GitFactsCache;
	/** the native fingerprint the git-ignored (CNG) native dir was last prebuilt at; absent = never regenerate it */
	prebuildStamp?: PrebuildStamp;
};

/** Where `runLocalBuild` records the native fingerprint a CNG `ios/` / `android/` was generated for. */
export type PrebuildStamp = { read: () => string | undefined; write: (native: string) => void };

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

/** Env that opts the iOS build into React Native's precompiled core (RN 0.81-0.83); independent of the compiler-cache switch. */
async function prebuiltRnEnv(deps: LocalBuildDeps): Promise<Record<string, string>> {
	const plan = await planPrebuiltRn({
		platform: deps.platform,
		projectRoot: deps.project.root,
		optOut: deps.project.prebuiltReactNative === false,
		env: deps.env,
		readFile: readFileOrUndefined,
	});
	return plan.env;
}

async function cacheEnv(deps: LocalBuildDeps): Promise<Record<string, string>> {
	const prebuilt = await prebuiltRnEnv(deps);
	if (deps.compilerCache === false) return prebuilt;
	const { platform } = deps;
	const gitTop = platform === "ios" ? await gitToplevel(deps) : undefined;
	const xcode = platform === "ios" ? await readXcode(deps.exec, deps.env) : undefined;
	return {
		...prebuilt,
		...compilerCacheEnv({
			platform,
			wardenHome: deps.wardenHome ?? resolveWardenHome(deps.env),
			gitTop: gitTop || undefined,
			xcodeMajor: xcode?.success ? xcode.data.major : undefined,
			enabled: true,
			baseEnv: deps.env,
		}),
	};
}

/** What a local build produced: the artifact, and the project's key after the build when the build itself moved it (17-1). */
export type LocalBuild = { artifact: string; postKey?: string };

/** iOS: `app`'s `CFBundleIdentifier` against the project's (a UI test runner or another app is a mismatch). */
type BundleCheck = "match" | "mismatch" | "unknown";

async function bundleCheck(deps: LocalBuildDeps, app: string): Promise<BundleCheck> {
	const want = deps.project.bundleId.ios;
	if (deps.platform !== "ios" || !want) return "unknown";
	const id = await probe(deps, ["plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Info.plist")]);
	if (id === undefined || id === "") return "unknown";
	return id === want ? "match" : "mismatch";
}

/**
 * `located`, minus iOS outputs whose bundle id reads as another app's (a UI test runner): each mismatch
 * is excluded and the build's outputs located again.
 */
async function locateOwnApp(deps: LocalBuildDeps, derivedData: string, before: ArtifactSnapshot) {
	const { project, platform } = deps;
	const exclude = new Set<string>();
	for (;;) {
		const located = locateArtifact(
			project.root,
			platform,
			derivedData,
			before,
			project.buildConfiguration,
			exclude,
			project.target
		);
		if (located === undefined) return located;
		const paths = located.kind === "ambiguous" ? located.paths : [located.path];
		const checks = await Promise.all(paths.map((p) => bundleCheck(deps, p)));
		const mismatched = paths.filter((_, i) => checks[i] === "mismatch");
		if (mismatched.length === 0) return located;
		for (const p of mismatched) exclude.add(p);
	}
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

/** a build command that generates a missing native dir: `expo prebuild`, or `expo run:*` (it prebuilds when the dir is absent) */
const PREBUILDS = /\bexpo\s+(prebuild|run:)/;

/**
 * Remove a CNG native dir generated for another native fingerprint, so the build command prebuilds it again. A
 * stale `ios/` keeps its old Podfile and a `Podfile.lock` that matches `Pods/Manifest.lock`, so the default command
 * skips both prebuild and `pod install`, and the build links none of the new native modules (`Cannot find native
 * module`) under the new key. Only an Expo app whose native dir is git-ignored (generated output, never hand-edited)
 * and whose build command prebuilds; a dir with no stamp was generated outside warden, for an unknown fingerprint.
 */
async function dropStaleNativeDir(deps: LocalBuildDeps, native: string): Promise<void> {
	const { project, platform, prebuildStamp } = deps;
	if (prebuildStamp === undefined || project.framework !== "expo") return;
	const nativeDir = join(project.root, platform);
	if (!existsSync(nativeDir) || !PREBUILDS.test(project.build[platform])) return;
	const stamp = prebuildStamp.read();
	if (stamp === native) return;
	try {
		const ignored = await deps.exec(["git", "check-ignore", "-q", platform], {
			cwd: project.root,
			timeoutMs: PROBE_TIMEOUT_MS,
		});
		if (ignored.exitCode !== 0) return;
	} catch {
		return;
	}
	const was = stamp === undefined ? "an unknown native fingerprint" : `native fingerprint ${stamp}`;
	deps.log(`${platform}/ was prebuilt for ${was} (now ${native}): removing it so the build prebuilds it again`);
	rmSync(nativeDir, { recursive: true, force: true });
}

/** The whole output of a failed build, kept for the errors the summary cannot show; best effort. */
function keepBuildLog(deps: LocalBuildDeps, res: ExecResult): string | undefined {
	const path = join(
		deps.wardenHome ?? resolveWardenHome(deps.env),
		"logs",
		`build-${deps.platform}-${deps.hash.slice(0, 12)}.log`
	);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`);
		return path;
	} catch {
		return undefined;
	}
}

/** Raw `xcodebuild` output `expo run:ios` leaves in the project (`.expo/xcodebuild.log`), when its own formatting hid the errors. */
function expoBuildLog(root: string): string {
	try {
		return readFileSync(join(root, ".expo", "xcodebuild.log"), "utf8");
	} catch {
		return "";
	}
}

/**
 * Why the build command failed. iOS: the compiler/linker errors with file:line:col (parsed from the output, or
 * expo's raw `xcodebuild.log`) and where the full log is kept; otherwise the last lines, as before.
 */
function describeBuildFailure(deps: LocalBuildDeps, argv: string[], res: ExecResult): string {
	const logPath = keepBuildLog(deps, res);
	if (deps.platform !== "ios") return `${execError(argv, res)}${logPath ? ` — full log: ${logPath}` : ""}`;
	const output = `${res.stdout}\n${res.stderr}`;
	let diagnostics = parseBuildDiagnostics(output);
	if (diagnostics.length === 0) diagnostics = parseBuildDiagnostics(expoBuildLog(deps.project.root));
	const summary = formatBuildFailure(diagnostics, logPath);
	return summary
		? `exited ${res.exitCode}, ${summary}`
		: `${execError(argv, res)}${logPath ? ` — full log: ${logPath}` : ""}`;
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
	const derivedData = derivedDataDir(deps.env);
	const snapshot = snapshotArtifacts(project.root, platform, derivedData, project.buildConfiguration, project.target);
	await dropStaleNativeDir(deps, deps.native ?? deps.hash);
	const before = await beforeBuild(deps);
	deps.log(`building ${platform} locally: ${command} (in ${project.root})`);
	const argv = ["sh", "-c", command];
	const caching = await cacheEnv(deps);
	const res = await deps.exec(argv, {
		cwd: project.root,
		env: { ...caching, ...project.buildEnv, EXPO_NO_TELEMETRY: "1" },
		timeoutMs: deps.timeoutMs ?? LOCAL_BUILD_TIMEOUT_MS,
		...(deps.output ? { onLine: deps.output } : {}),
	});
	if (res.exitCode !== 0) return err(`local build failed: ${describeBuildFailure(deps, argv, res)}`);
	const after = await computeCacheKey(deps.exec, project, platform, undefined, undefined, deps.env);
	if (!after.success) return after;
	const moved = after.data.key !== deps.hash;
	if (moved && !(await prebuildMovedKey(deps, before, after.data))) {
		return err(`fingerprint changed during the build (${deps.hash} → ${after.data.key}); not caching`);
	}
	const located = await locateOwnApp(deps, derivedData, snapshot);
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
	deps.prebuildStamp?.write(after.data.native);
	if (located.kind === "up-to-date") deps.log(`build was up to date; reusing ${artifact}`);
	if (moved)
		deps.log(`the build created ${platform}/ (prebuild): caching under ${deps.hash}, aliased as ${after.data.key}`);
	return ok(moved ? { artifact, postKey: after.data.key } : { artifact });
}
