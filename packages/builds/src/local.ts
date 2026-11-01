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
import { type Exec, type ExecResult, execErrors } from "@delacour/warden-runtime/exec";
import { GitFactsCache, gitFactsReader } from "@delacour/warden-runtime/git-facts";
import { xcodeReader } from "@delacour/warden-runtime/xcode";
import { storeLocator } from "@delacour/warden-store/store";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import type { BuildConfiguration } from "./builds.defaults";
import { LOCAL_BUILD_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "./builds.defaults";
import { compilerCache } from "./compiler-cache";
import type { Project } from "./config";
import { buildDiagnostics } from "./diagnostics";
import { type CacheKey, fingerprint } from "./fingerprint";
import { jsInputs } from "./js-inputs";
import type { BuildTarget } from "./kinds";
import { prebuiltRn } from "./prebuilt-rn";

/** Every candidate's mtime, taken just before the build runs. */
export type ArtifactSnapshot = ReadonlyMap<string, number>;

/**
 * `rebuilt`: new or rewritten during the build. `up-to-date`: the build left this project's only
 * matching output in place. `ambiguous`: it left several, so none can be told apart from a stale one.
 */
export type LocatedArtifact =
	| { kind: "rebuilt"; path: string }
	| { kind: "up-to-date"; path: string }
	| { kind: "ambiguous"; paths: string[] };

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Finds the `.app` / `.apk` a local build produced. Pure; the filesystem is read per call. */
export class ArtifactLocator {
	/**
	 * Candidate build outputs for `configuration`: iOS `.app`s in `<root>/ios/build/…/<Config>-iphonesimulator`
	 * and every DerivedData project's `…/<Config>-iphonesimulator` (`-iphoneos` for a `device` target); Android `.apk`s under
	 * `<root>/android/app/build/outputs/apk` whose variant directory is that configuration (never an
	 * `androidTest` APK).
	 */
	candidates(
		root: string,
		platform: Platform,
		derivedData: string,
		configuration: BuildConfiguration = "Debug",
		target: BuildTarget = "simulator"
	): string[] {
		if (platform === "android") {
			const outputs = join(root, "android", "app", "build", "outputs", "apk");
			return this.findFiles(outputs, ".apk").filter(
				(apk) => this.isApkOf(apk, outputs, configuration) && !this.isTestApk(apk, outputs)
			);
		}
		const products = this.iosProducts(configuration, target);
		const productDirs = [
			join(root, "ios", "build", products),
			...this.children(derivedData).map((d) => join(d, products)),
		];
		return productDirs.flatMap((d) => this.children(d).filter((p) => p.endsWith(".app")));
	}

	snapshot(
		root: string,
		platform: Platform,
		derivedData: string,
		configuration: BuildConfiguration = "Debug",
		target: BuildTarget = "simulator"
	): ArtifactSnapshot {
		return new Map(this.candidates(root, platform, derivedData, configuration, target).map((p) => [p, this.mtime(p)]));
	}

	/**
	 * The artifact a successful build produced, vs the `before` snapshot: the newest of this project's
	 * candidates it created or rewrote; else, for an up-to-date build (Gradle / xcodebuild skipped every
	 * task), this project's single unchanged candidate; else the newest rewritten candidate of unknown
	 * owner (a workspace outside `<root>/ios`). `exclude`: candidates already ruled out (another bundle id).
	 */
	locate(
		root: string,
		platform: Platform,
		derivedData: string,
		before: ArtifactSnapshot,
		configuration: BuildConfiguration = "Debug",
		exclude: ReadonlySet<string> = new Set(),
		target: BuildTarget = "simulator"
	): LocatedArtifact | undefined {
		const candidates = this.candidates(root, platform, derivedData, configuration, target)
			.filter((path) => !exclude.has(path))
			.map((path) => ({ path, at: this.mtime(path), owned: this.ownedBy(path, root, derivedData) }))
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

	derivedDataDir(env: Record<string, string | undefined>): string {
		return join(env.HOME ?? "~", "Library", "Developer", "Xcode", "DerivedData");
	}

	private iosProducts(configuration: BuildConfiguration, target: BuildTarget): string {
		return join("Build", "Products", `${configuration}-${target === "device" ? "iphoneos" : "iphonesimulator"}`);
	}

	private children(dir: string): string[] {
		try {
			return readdirSync(dir).map((n) => join(dir, n));
		} catch {
			return [];
		}
	}

	private mtime(path: string): number {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return 0;
		}
	}

	/** Recursively collect files ending in `ext` under `dir` (bounded depth). */
	private findFiles(dir: string, ext: string, depth = 6): string[] {
		if (depth < 0) return [];
		return this.children(dir).flatMap((p) => {
			if (p.endsWith(ext)) return [p];
			try {
				return statSync(p).isDirectory() ? this.findFiles(p, ext, depth - 1) : [];
			} catch {
				return [];
			}
		});
	}

	/** Is `apk` a build of `configuration`? (`apk/release/…`, `apk/<flavor>/release/…`, `apk/fooRelease/…`) */
	private isApkOf(apk: string, outputs: string, configuration: BuildConfiguration): boolean {
		const want = configuration.toLowerCase();
		return relative(outputs, dirname(apk))
			.split(sep)
			.some((segment) => segment.toLowerCase().endsWith(want));
	}

	/** An instrumentation / Detox test APK (`apk/androidTest/…`): never the app. */
	private isTestApk(apk: string, outputs: string): boolean {
		return relative(outputs, dirname(apk)).split(sep).includes("androidTest");
	}

	private real(path: string): string {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	}

	private samePath(a: string, b: string): boolean {
		return a === b || this.real(a) === this.real(b);
	}

	private isInside(path: string, root: string): boolean {
		const rel = relative(this.real(root), this.real(path));
		return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
	}

	/** Xcode records the workspace a DerivedData dir belongs to in its `info.plist` (`WorkspacePath`). */
	private derivedDataWorkspace(projectDir: string): string | undefined {
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
	private ownedBy(artifact: string, root: string, derivedData: string): boolean {
		if (this.isInside(artifact, root)) return true;
		const [projectDir] = relative(derivedData, artifact).split(sep);
		if (!projectDir || projectDir.startsWith("..")) return false;
		const workspace = this.derivedDataWorkspace(join(derivedData, projectDir));
		return workspace !== undefined && this.samePath(dirname(workspace), join(root, "ios"));
	}
}

export const artifactLocator = new ArtifactLocator();

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

/** Where `LocalBuilder.run` records the native fingerprint a CNG `ios/` / `android/` was generated for. */
export type PrebuildStamp = { read: () => string | undefined; write: (native: string) => void };

/** What a local build produced: the artifact, and the project's key after the build when the build itself moved it (17-1). */
export type LocalBuild = { artifact: string; postKey?: string };

/** iOS: `app`'s `CFBundleIdentifier` against the project's (a UI test runner or another app is a mismatch). */
type BundleCheck = "match" | "mismatch" | "unknown";

/** What the build may legitimately change: the native dir it creates on a fresh checkout. */
type BeforeBuild = { nativeDir: string; nativeDirExisted: boolean; status?: string };

/** a build command that generates a missing native dir: `expo prebuild`, or `expo run:*` (it prebuilds when the dir is absent) */
const PREBUILDS = /\bexpo\s+(prebuild|run:)/;

/**
 * One local build, built around a single `LocalBuildDeps` bag: `new LocalBuilder(deps).run()`.
 * Every other method is a private step of that run.
 */
export class LocalBuilder {
	constructor(private readonly deps: LocalBuildDeps) {}

	/**
	 * Run `build.<platform>` in the project root, locate the produced `.app`/`.apk`, and verify the
	 * project's cache key (native fingerprint, plus the JS sources for a JS-aware project) still equals
	 * `hash` (a build that changed native inputs — or a source tree edited mid-build — must not be cached
	 * under the old hash). The one accepted move: a fresh checkout's prebuild created the native dir
	 * (`postKey`, see `prebuildMovedKey`).
	 */
	async run(): AsyncResult<LocalBuild> {
		const { deps } = this;
		const { project, platform } = deps;
		const command = project.build[platform];
		const derivedData = artifactLocator.derivedDataDir(deps.env);
		const snapshot = artifactLocator.snapshot(
			project.root,
			platform,
			derivedData,
			project.buildConfiguration,
			project.target
		);
		await this.dropStaleNativeDir(deps.native ?? deps.hash);
		const before = await this.beforeBuild();
		deps.log(`building ${platform} locally: ${command} (in ${project.root})`);
		const argv = ["sh", "-c", command];
		const caching = await this.cacheEnv();
		const res = await deps.exec(argv, {
			cwd: project.root,
			env: { ...caching, ...project.buildEnv, EXPO_NO_TELEMETRY: "1" },
			timeoutMs: deps.timeoutMs ?? LOCAL_BUILD_TIMEOUT_MS,
			...(deps.output ? { onLine: deps.output } : {}),
		});
		if (res.exitCode !== 0) {
			return resultFactory.err(`local build failed: ${this.describeBuildFailure(argv, res)}`);
		}
		const after = await fingerprint.computeCacheKey(deps.exec, project, platform, undefined, undefined, deps.env);
		if (!after.success) return after;
		const moved = after.data.key !== deps.hash;
		if (moved && !(await this.prebuildMovedKey(before, after.data))) {
			return resultFactory.err(`fingerprint changed during the build (${deps.hash} → ${after.data.key}); not caching`);
		}
		return this.finish(derivedData, snapshot, after.data, moved);
	}

	/** Locate the produced artifact once the key checks out, and record the prebuild stamp. */
	private async finish(
		derivedData: string,
		snapshot: ArtifactSnapshot,
		after: CacheKey,
		moved: boolean
	): AsyncResult<LocalBuild> {
		const { deps } = this;
		const { project, platform } = deps;
		const located = await this.locateOwnApp(derivedData, snapshot);
		const kind = `${project.buildConfiguration} ${platform === "ios" ? ".app" : ".apk"}`;
		if (located?.kind === "ambiguous") {
			return resultFactory.err(
				`local build was up to date but left ${located.paths.length} ${kind}s, any of which could be stale: ${located.paths.join(", ")}; delete the ones this build should not produce and retry`
			);
		}
		if (!located || !existsSync(located.path)) {
			return resultFactory.err(
				`local build succeeded but no ${kind} was found (DerivedData / android/app/build/outputs)`
			);
		}
		const artifact = located.path;
		deps.prebuildStamp?.write(after.native);
		if (located.kind === "up-to-date") deps.log(`build was up to date; reusing ${artifact}`);
		if (moved)
			deps.log(`the build created ${platform}/ (prebuild): caching under ${deps.hash}, aliased as ${after.key}`);
		return resultFactory.ok(moved ? { artifact, postKey: after.key } : { artifact });
	}

	private async probe(argv: string[], cwd?: string): Promise<string | undefined> {
		try {
			const res = await this.deps.exec(argv, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
			return res.exitCode === 0 ? res.stdout.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	/** The project's git toplevel from the facts the command already read; a failed read is no toplevel, never a failed build. */
	private async gitToplevel(): Promise<string | undefined> {
		const { deps } = this;
		try {
			return (await gitFactsReader.read(deps.exec, deps.project.root, deps.git ?? new GitFactsCache()))?.toplevel;
		} catch {
			return undefined;
		}
	}

	/** Env that opts the iOS build into React Native's precompiled core (RN 0.81-0.83); independent of the compiler-cache switch. */
	private async prebuiltRnEnv(): Promise<Record<string, string>> {
		const { deps } = this;
		const plan = await prebuiltRn.plan({
			platform: deps.platform,
			projectRoot: deps.project.root,
			optOut: deps.project.prebuiltReactNative === false,
			env: deps.env,
			readFile: jsInputs.readFileOrUndefined,
		});
		return plan.env;
	}

	private async cacheEnv(): Promise<Record<string, string>> {
		const { deps } = this;
		const prebuilt = await this.prebuiltRnEnv();
		if (deps.compilerCache === false) return prebuilt;
		const { platform } = deps;
		const gitTop = platform === "ios" ? await this.gitToplevel() : undefined;
		const xcode = platform === "ios" ? await xcodeReader.read(deps.exec, deps.env) : undefined;
		return {
			...prebuilt,
			...compilerCache.env({
				platform,
				wardenHome: deps.wardenHome ?? storeLocator.wardenHome(deps.env),
				gitTop: gitTop || undefined,
				xcodeMajor: xcode?.success ? xcode.data.major : undefined,
				enabled: true,
				baseEnv: deps.env,
			}),
		};
	}

	private async bundleCheck(app: string): Promise<BundleCheck> {
		const { deps } = this;
		const want = deps.project.bundleId.ios;
		if (deps.platform !== "ios" || !want) return "unknown";
		const id = await this.probe([
			"plutil",
			"-extract",
			"CFBundleIdentifier",
			"raw",
			"-o",
			"-",
			join(app, "Info.plist"),
		]);
		if (id === undefined || id === "") return "unknown";
		return id === want ? "match" : "mismatch";
	}

	/**
	 * `located`, minus iOS outputs whose bundle id reads as another app's (a UI test runner): each mismatch
	 * is excluded and the build's outputs located again.
	 */
	private async locateOwnApp(derivedData: string, before: ArtifactSnapshot) {
		const { project, platform } = this.deps;
		const exclude = new Set<string>();
		for (;;) {
			const located = artifactLocator.locate(
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
			const checks = await Promise.all(paths.map((p) => this.bundleCheck(p)));
			const mismatched = paths.filter((_, i) => checks[i] === "mismatch");
			if (mismatched.length === 0) return located;
			for (const p of mismatched) exclude.add(p);
		}
	}

	/** `git status` of the whole checkout minus the platform's native dir (native-only projects' mid-build edit check). */
	private statusArgv(): string[] {
		return ["git", "status", "--porcelain", "--", ":/", `:(exclude)${this.deps.platform}`];
	}

	private async beforeBuild(): Promise<BeforeBuild> {
		const { deps } = this;
		const nativeDir = join(deps.project.root, deps.platform);
		const nativeDirExisted = existsSync(nativeDir);
		if (nativeDirExisted || deps.project.jsInputs !== undefined) return { nativeDir, nativeDirExisted };
		const status = await this.probeRaw(this.statusArgv(), deps.project.root);
		return { nativeDir, nativeDirExisted, ...(status !== undefined ? { status } : {}) };
	}

	private async probeRaw(argv: string[], cwd: string): Promise<string | undefined> {
		try {
			const res = await this.deps.exec(argv, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
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
	private async prebuildMovedKey(before: BeforeBuild, after: CacheKey): Promise<boolean> {
		const { deps } = this;
		if (before.nativeDirExisted || !existsSync(before.nativeDir)) return false;
		if (deps.project.jsInputs !== undefined) {
			return (
				deps.native !== undefined && after.js !== undefined && jsInputs.combineKey(deps.native, after.js) === deps.hash
			);
		}
		if (before.status === undefined) return false;
		const now = await this.probeRaw(this.statusArgv(), deps.project.root);
		return now === before.status;
	}

	/**
	 * Remove a CNG native dir generated for another native fingerprint, so the build command prebuilds it again. A
	 * stale `ios/` keeps its old Podfile and a `Podfile.lock` that matches `Pods/Manifest.lock`, so the default command
	 * skips both prebuild and `pod install`, and the build links none of the new native modules (`Cannot find native
	 * module`) under the new key. Only an Expo app whose native dir is git-ignored (generated output, never hand-edited)
	 * and whose build command prebuilds; a dir with no stamp was generated outside warden, for an unknown fingerprint.
	 */
	private async dropStaleNativeDir(native: string): Promise<void> {
		const { deps } = this;
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
	private keepBuildLog(res: ExecResult): string | undefined {
		const { deps } = this;
		const path = join(
			deps.wardenHome ?? storeLocator.wardenHome(deps.env),
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
	private expoBuildLog(root: string): string {
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
	private describeBuildFailure(argv: string[], res: ExecResult): string {
		const { deps } = this;
		const logPath = this.keepBuildLog(res);
		if (deps.platform !== "ios") return `${execErrors.format(argv, res)}${logPath ? ` — full log: ${logPath}` : ""}`;
		const output = `${res.stdout}\n${res.stderr}`;
		let diagnostics = buildDiagnostics.parse(output);
		if (diagnostics.length === 0) diagnostics = buildDiagnostics.parse(this.expoBuildLog(deps.project.root));
		const summary = buildDiagnostics.formatFailure(diagnostics, logPath);
		return summary
			? `exited ${res.exitCode}, ${summary}`
			: `${execErrors.format(argv, res)}${logPath ? ` — full log: ${logPath}` : ""}`;
	}
}
