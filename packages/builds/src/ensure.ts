import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { InstallMode } from "@delacour/warden-config/app-option.schema";
import type { Exec } from "@delacour/warden-runtime/exec";
import { GitFactsCache, gitFactsReader } from "@delacour/warden-runtime/git-facts";
import { type BuildSource, BuildsTable } from "@delacour/warden-store/builds-table";
import type { PidAlive } from "@delacour/warden-store/liveness";
import type { Store } from "@delacour/warden-store/store";
import type { Owner, Platform } from "@delacour/warden-store/types";
import { wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { appConfig } from "./app-config";
import { buildCache, type KindKey } from "./cache";
import { type EasSettings, type Project, projectConfig } from "./config";
import { type Download, EasResolver } from "./eas";
import { fingerprint } from "./fingerprint";
import {
	type FileDigest,
	type FileSize,
	type FileStamp,
	type InstallTarget,
	installer,
	nodeResetFs,
	type ResetFs,
} from "./install";
import { type DeviceIo, installDevice } from "./install-device";
import { type DeviceTarget, kinds } from "./kinds";
import { liveLogs } from "./live-log";
import { LocalBuilder, type PrebuildStamp } from "./local";
import { type BuildLockDeps, buildLock } from "./lock";
import { overlay } from "./overlay";
import { projectKeys } from "./project-key";
import {
	type AppPhase,
	AppResolver,
	type BuildStepOutcome,
	type DeviceSteps,
	type EnsureResult,
	type ResolveSteps,
} from "./resolve";

/** Cache `profile` for builds with no EAS profile (local / imported only). */
export const LOCAL_PROFILE = "local";

export type ProjectContext = {
	project: Project;
	projectKey: string;
	/** set when a dynamic `app.config.*` was resolved through `expo config`: the slug and scheme it reported */
	appConfig?: { slug?: string; scheme?: string };
};

export type ProjectContextInput = {
	exec: Exec;
	env: Record<string, string | undefined>;
	/** `--project` dir or cwd */
	start: string;
	name?: string;
	bundleId?: Project["bundleId"];
	/** `projects[].variants.<name>` */
	variant?: string;
	/** a missing variant falls back to the project's own settings */
	variantOptional?: boolean;
	/** per-command memo of the git facts (default: a short-lived shared one) */
	git?: GitFactsCache;
};

export type EnsureInput = ProjectContext & {
	store: Store;
	exec: Exec;
	env: Record<string, string | undefined>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
	/** a local build's own output, line by line, while it runs (`LocalBuildDeps.output`) */
	buildOutput?: (line: string) => void;
	pidAlive: PidAlive;
	/** owner + pid of the build lock */
	owner: Owner;
	pid: number;
	platform: Platform;
	/** cache / install key */
	hash: string;
	/** the `@expo/fingerprint` hash EAS indexes by, when it differs from `hash` (default `hash`) */
	native?: string;
	/** udid / serial to install onto; absent = resolve the artifact only */
	deviceId?: string;
	/** the device is a real phone: Android installs check the APK's ABIs against it first */
	physical?: boolean;
	/** false = `--no-eas` */
	eas: boolean;
	/** false = `--no-build` */
	build: boolean;
	/** `--install-mode`: reset the installed app first (`clean`: fresh data, `reinstall`: uninstall + install) */
	installMode?: InstallMode;
	/** `--reset-keychain`: also reset the iOS sim keychain (needs `installMode`) */
	resetKeychain?: boolean;
	/** filesystem for `installMode: "clean"`'s data wipe (default node:fs) */
	resetFs?: ResetFs;
	/** the temp files of `devicectl` calls on a physical iPhone (default node:fs) */
	deviceIo?: DeviceIo;
	/** file sizes for the installed-app identity check (default node:fs) */
	fileSize?: FileSize;
	/** `ino:mtime` of the installed executable, recorded at install to skip that check (default node:fs) */
	fileStamp?: FileStamp;
	/** sha256 of the cached apk for the Android installed-app identity check (default node:fs) */
	fileDigest?: FileDigest;
	download?: Download;
	easPollMs?: number;
	lockPollMs?: number;
	/** per-command memo of the git facts, shared with `projectContext` (default: a short-lived shared one) */
	git?: GitFactsCache;
	/** progress for a spinner: fetching / waiting / building / installing / ready (`AppPhase`) */
	onPhase?: (phase: AppPhase) => void;
	/** set by `KindBuildEnsurer`: the build goes into its kind dir and a local build is verified against `buildKey` */
	kind?: { key: KindBuildKey; buildKey: string };
};

/** The kind builds `KindBuildEnsurer` makes: a repack is made from a base by the repack engine, never built. */
export type KindBuildKey = Exclude<KindKey, { kind: "simulator-repack" }>;

export type EnsureKindInput = Omit<EnsureInput, "hash" | "kind" | "project"> & {
	/** the project as loaded (kind-less); `KindBuildEnsurer` resolves it as the kind of `key` */
	project: Project;
	/** which build: `dev`, the `simulator-base`, or a `release` (a repack is made from a base, not built) */
	key: KindBuildKey;
	/** the key `computeCacheKey` gives the kind's project: what a local build is verified against (`computeKindKey().buildKey`) */
	buildKey: string;
};

/** Loads a project and its project key: singleton `projectContextLoader`. */
export class ProjectContextLoader {
	/** Load the project for `start` (bounded by its git toplevel) and compute its project key. */
	async load(input: ProjectContextInput): AsyncResult<ProjectContext> {
		const facts = await gitFactsReader.read(input.exec, input.start, input.git ?? new GitFactsCache());
		const stopAt = facts?.toplevel;
		const overlayDir = await overlay.dirUnlessRepoConfig(input.exec, input.start, stopAt, input.env, input.git);
		// a monorepo root with one app below it: look the project up from that app
		const start = projectConfig.appStart(input.start, stopAt, overlayDir);
		const load = {
			start,
			env: input.env,
			...(stopAt ? { stopAt } : {}),
			...(overlayDir ? { overlayDir } : {}),
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.bundleId ? { bundleId: input.bundleId } : {}),
			...(input.variant !== undefined ? { variant: input.variant } : {}),
			...(input.variantOptional ? { variantOptional: true } : {}),
		};
		const loaded = await this.loadProject(input, load, start, stopAt, overlayDir);
		if (!loaded.success) return loaded;
		const { project, appConfig: dynamic } = loaded.data;
		const key = await projectKeys.read(input.exec, project.root, input.git);
		if (!key.success) return key;
		return resultFactory.ok({ project, projectKey: key.data, ...(dynamic ? { appConfig: dynamic } : {}) });
	}

	private async loadProject(
		input: ProjectContextInput,
		load: Parameters<typeof projectConfig.load>[0],
		start: string,
		stopAt: string | undefined,
		overlayDir: string | undefined
	): AsyncResult<{ project: Project; appConfig?: ProjectContext["appConfig"] }> {
		const first = projectConfig.load(load);
		if (first.success) return resultFactory.ok({ project: first.data });
		const dynamicDir = projectConfig.dynamicAppConfigDir(start, stopAt, input.bundleId, overlayDir);
		if (dynamicDir === undefined) return first;
		// the app's config is code: only Expo can resolve it, so ask Expo once and detect again with its answer
		const read = await appConfig.read(input.exec, dynamicDir);
		if (!read.success) return resultFactory.err(`${first.error}; ${read.error}`);
		const dynamic = {
			...(read.data.slug ? { slug: read.data.slug } : {}),
			...(read.data.scheme ? { scheme: read.data.scheme } : {}),
		};
		const second = projectConfig.load({
			...load,
			bundleId: { ...read.data.bundleId, ...input.bundleId },
			...(read.data.slug ? { appName: read.data.slug } : {}),
		});
		if (!second.success) return second;
		return resultFactory.ok({ project: second.data, appConfig: dynamic });
	}
}

export const projectContextLoader = new ProjectContextLoader();

/** Store-backed prebuild stamps: singleton `prebuildStamps`. */
export class PrebuildStamps {
	/** The store's record of the native fingerprint `<root>/<platform>` was last prebuilt for (a CNG dir is per checkout). */
	of(store: Store, root: string, platform: Platform): PrebuildStamp {
		const key = `prebuild:${platform}:${join(root, platform)}`;
		return { read: () => store.getMeta(key), write: (native) => store.setMeta(key, native) };
	}
}

export const prebuildStamps = new PrebuildStamps();

type CacheFn = (path: string, source: BuildSource, move: boolean) => ReturnType<typeof buildCache.storeArtifact>;

/**
 * Wires the real effects (sqlite cache, simctl/adb, eas-cli, local build) into `AppResolver`: construct with the
 * `EnsureInput`, call `ensure()`. Every other method is a private step of that run.
 */
export class AppEnsurer {
	/** the key later runs in this checkout compute: the post-prebuild key once this call's build re-keyed (17-1) */
	private installKey: string;

	constructor(private readonly input: EnsureInput) {
		this.installKey = input.hash;
	}

	/** Wire the real effects (sqlite cache, simctl/adb, eas-cli, local build) into `AppResolver`. */
	async ensure(): AsyncResult<EnsureResult> {
		const { input } = this;
		const { store, env, project, projectKey, platform, hash } = input;
		const steps: ResolveSteps = {
			hash,
			flightKey: `${buildCache.root(env)}|${buildLock.key(projectKey, platform, hash)}`,
			...(input.installMode !== undefined ? { installMode: input.installMode } : {}),
			log: input.log,
			...(input.onPhase ? { onPhase: input.onPhase } : {}),
			cached: () => buildCache.cached(store, projectKey, platform, hash, input.now())?.path,
			legacy: async () => {
				if (input.kind) return resultFactory.ok(undefined);
				const found = buildCache.findLegacyArtifact(project.cacheDirs, platform, hash);
				if (!found) return resultFactory.ok(undefined);
				const stored = await this.cache(found, "legacy", false);
				return stored.success ? resultFactory.ok(stored.data.path) : stored;
			},
			lock: (fn) => this.lockFollowing(buildLock.key(projectKey, platform, hash), fn),
		};

		const easSettings = project.eas;
		// an EAS build is a dev or release build: it can never be the simulator base, whose point is carrying no JS bundle,
		// nor a build signed for a phone (EAS builds are signed by EAS)
		const easApplies = input.kind?.key.kind !== "simulator-base" && !this.deviceOf(input.kind?.key);
		if (input.eas && easSettings && easApplies) steps.eas = this.easStep(easSettings);
		if (input.build) steps.build = this.buildStep();

		if (input.deviceId !== undefined) {
			const bundleId = projectConfig.bundleIdFor(project, platform);
			if (!bundleId.success) return wardenErrors.toText(bundleId);
			steps.device = this.deviceSteps(input.deviceId, bundleId.data);
		}
		return new AppResolver(steps).resolve();
	}

	/** Store the artifact under the requested key (in the kind's dir for a kind build). */
	private readonly cache: CacheFn = (path, source, move) => {
		const { input } = this;
		const layout = input.kind && {
			dir: buildCache.kindDir(input.env, input.projectKey, input.platform, input.kind.key),
			kind:
				input.kind.key.kind === "release"
					? { kind: "release" as const, jsKey: input.kind.key.jsKey }
					: input.kind.key.kind,
		};
		return buildCache.storeArtifact({
			store: input.store,
			env: input.env,
			projectKey: input.projectKey,
			platform: input.platform,
			profile: this.profileOf(input.project),
			hash: input.hash,
			artifact: path,
			source,
			move,
			...(layout ? { layout } : {}),
			now: input.now(),
		});
	};

	/** an install at `recorded` is this build when both keys name the same cached files (an alias) */
	private installedAt(recorded: string | undefined): string | undefined {
		const { store, projectKey, platform, hash } = this.input;
		if (recorded === undefined || recorded === hash) return recorded;
		const mine = new BuildsTable(store).get(projectKey, platform, hash)?.path;
		return mine !== undefined && new BuildsTable(store).get(projectKey, platform, recorded)?.path === mine
			? hash
			: recorded;
	}

	/** The device step set: probe / identity check / uninstall / reset / install against `deviceId`. */
	private deviceSteps(deviceId: string, bundleId: string): DeviceSteps {
		const { input } = this;
		const { store, env, platform } = input;
		const target: InstallTarget = { platform, deviceId, ...(input.physical === true ? { physical: true } : {}) };
		const deps = {
			exec: input.exec,
			env,
			...(input.fileSize ? { fileSize: input.fileSize } : {}),
			...(input.deviceIo ? { deviceIo: input.deviceIo } : {}),
			...(input.fileDigest ? { fileDigest: input.fileDigest } : {}),
		};
		return {
			installedHash: () => this.installedAt(new BuildsTable(store).getInstall(platform, deviceId, bundleId)?.hash),
			confirm: () => installer.probe(deps, target, bundleId),
			matches: async (cachedPath, installed) => {
				// a phone has no container to stat: the install record named this build, devicectl names its version
				if (installer.isPhoneIos(target)) {
					return resultFactory.ok(await installDevice.appMatches(input.exec, cachedPath, installed));
				}
				// the container this process recorded at install, executable untouched: that install (17-7, no plutil)
				const record = new BuildsTable(store).getInstall(platform, deviceId, bundleId);
				const container = installed.container;
				if (container !== undefined && record?.container === container && record.exeStamp !== undefined) {
					if ((await installer.executableStamp(container, input.fileStamp)) === record.exeStamp) {
						return resultFactory.ok(true);
					}
				}
				return installer.appMatchesArtifact(deps, target, bundleId, cachedPath, container);
			},
			uninstall: async () => {
				input.log(`uninstalling ${bundleId} from ${deviceId} (${input.installMode ?? "reinstall"})`);
				const gone = await installer.uninstall(deps, target, bundleId);
				return gone.success && input.resetKeychain ? installer.resetSimKeychain(deps, target) : gone;
			},
			reset: () => {
				input.log(`resetting ${bundleId} data on ${deviceId} (clean)`);
				const fs = input.resetFs ?? nodeResetFs;
				return installer.resetAppData({ ...deps, fs }, target, bundleId, { keychain: input.resetKeychain === true });
			},
			install: async (appPath) => {
				input.log(`installing ${appPath} on ${deviceId}`);
				const done = await installer.installAndProbe(deps, target, appPath, bundleId);
				if (!done.success) return done;
				const { container } = done.data;
				const exeStamp =
					container === undefined ? undefined : await installer.executableStamp(container, input.fileStamp);
				new BuildsTable(store).recordInstall({
					platform,
					deviceId,
					bundleId,
					hash: this.installKey,
					installedAt: input.now(),
					...(container !== undefined ? { container } : {}),
					...(exeStamp !== undefined ? { exeStamp } : {}),
				});
				return resultFactory.ok(undefined);
			},
		};
	}

	/**
	 * HEAD's sha when the working tree is clean. A JS-aware key covers JS the EAS fingerprint doesn't, so
	 * EAS can only be trusted for a build of the exact commit being tested — dirty tree, no EAS.
	 */
	private async cleanHead(cwd: string): AsyncResult<string> {
		const { exec } = this.input;
		const status = await exec(["git", "status", "--porcelain"], { cwd });
		if (status.exitCode !== 0) return resultFactory.err("EAS skipped: not a git checkout");
		if (status.stdout.trim() !== "") return resultFactory.err("EAS skipped: working tree is not clean (JS-aware key)");
		const head = await exec(["git", "rev-parse", "HEAD"], { cwd });
		const sha = head.stdout.trim();
		return head.exitCode === 0 && sha ? resultFactory.ok(sha) : resultFactory.err("EAS skipped: could not read HEAD");
	}

	/** Cache `profile`: the EAS profile (or `local`), `:<variant>` / `:<kind>` when the project was resolved with one. */
	private profileOf(project: Project): string {
		const profile = project.eas?.profile ?? LOCAL_PROFILE;
		if (project.variant !== undefined) return `${profile}:${project.variant}`;
		return project.kind === undefined ? profile : `${profile}:${project.kind}`;
	}

	/**
	 * The cache key a prebuild re-key (17-1) gives a kind build. `dev` and the simulator base are keyed by the build key
	 * itself, so the re-keyed build is the same kind of build at `postKey`; a `release` key mixes in the JS and cannot be
	 * rebuilt from `postKey` alone (no alias: the next run misses once and builds again).
	 */
	private postKindHash(key: KindBuildKey, postKey: string): string | undefined {
		if (key.kind === "release") return undefined;
		if (key.kind === "dev") {
			return buildCache.kindHash({ kind: "dev", nativeFp: postKey, ...(key.device ? { device: key.device } : {}) });
		}
		return buildCache.kindHash({ kind: key.kind, nativeFp: postKey });
	}

	/** The EAS step: JS-aware projects look builds up by (clean) HEAD commit, the rest by fingerprint hash. */
	private easStep(eas: EasSettings): NonNullable<ResolveSteps["eas"]> {
		const { input } = this;
		const { project, platform } = input;
		const hash = input.native ?? input.hash;
		return async () => {
			const head = project.jsInputs === undefined ? undefined : await this.cleanHead(project.root);
			if (head && !head.success) return resultFactory.ok({ kind: "miss", reason: head.error });
			input.onPhase?.({ phase: "fetching", source: "eas" });
			const outcome = await new EasResolver({
				exec: input.exec,
				cwd: project.root,
				platform,
				hash,
				...(head ? { commit: head.data } : {}),
				eas,
				now: input.now,
				sleep: input.sleep,
				log: input.log,
				...(input.download ? { download: input.download } : {}),
				...(input.easPollMs !== undefined ? { pollMs: input.easPollMs } : {}),
			}).resolveFromEas();
			if (outcome.kind === "miss") return resultFactory.ok(outcome);
			const stored = await this.cache(outcome.path, "eas", true);
			return stored.success ? resultFactory.ok({ kind: "hit", path: stored.data.path }) : stored;
		};
	}

	/** A prebuild re-key (17-1): alias the build under the post-build key and report it, when there is one to alias. */
	private aliasPostKey(stored: Parameters<typeof buildCache.alias>[1], postKey: string | undefined): void {
		const { input } = this;
		if (postKey === undefined) return;
		const aliasHash = input.kind ? this.postKindHash(input.kind.key, postKey) : postKey;
		if (aliasHash === undefined) return;
		buildCache.alias(input.store, stored, aliasHash, input.now());
		this.onPostKey(aliasHash);
	}

	private readonly onPostKey = (postKey: string): void => {
		this.installKey = postKey;
	};

	/** The checkout as one path, so two spellings of it (a symlinked worktree) share its tree lock. */
	private realRoot(root: string): string {
		try {
			return realpathSync(root);
		} catch {
			return root;
		}
	}

	/**
	 * Hold build lock `key` for `fn`. While another warden holds it: report `waiting` once and mirror its build output
	 * (its live log) into this run's `buildOutput`, then drain the rest once the lock is ours, so a waiter shows the build
	 * as if it ran it.
	 */
	private lockFollowing<T>(
		key: string,
		fn: () => AsyncResult<T>,
		waitLine?: (holder: string) => string
	): AsyncResult<T> {
		const { input } = this;
		const tail = input.buildOutput ? liveLogs.tail(input.store, key, input.buildOutput) : undefined;
		let waited = false;
		const deps: BuildLockDeps = {
			store: input.store,
			owner: input.owner,
			pid: input.pid,
			now: input.now,
			pidAlive: input.pidAlive,
			sleep: input.sleep,
			log: input.log,
			...(input.lockPollMs !== undefined ? { pollMs: input.lockPollMs } : {}),
			...(waitLine ? { waitLine } : {}),
			onWait: () => {
				if (!waited) input.onPhase?.({ phase: "waiting" });
				waited = true;
				tail?.poll();
			},
		};
		return buildLock.hold(deps, key, () => {
			if (waited) tail?.drain();
			return fn();
		});
	}

	/**
	 * Under the checkout's tree lock, before building: the build another warden made here while this one waited. Its own
	 * key may be cached by now; else the checkout is fingerprinted again (this run's key may have been read off a
	 * half-written prebuild), and a build cached under that key is used (installed under it). A checkout that moved to a
	 * key nothing is cached under is an error: building it would be verified against the wrong key.
	 */
	private async builtMeanwhile(): AsyncResult<BuildStepOutcome | undefined> {
		const { input } = this;
		const { store, projectKey, platform, hash } = input;
		const mine = buildCache.cached(store, projectKey, platform, hash, input.now());
		if (mine) return resultFactory.ok({ kind: "cached", path: mine.path });
		const verified = input.kind?.buildKey ?? hash;
		const now = await fingerprint.computeCacheKey(input.exec, input.project, platform, undefined, undefined, input.env);
		if (!now.success) return now;
		if (now.data.key === verified) return resultFactory.ok(undefined);
		const movedHash = input.kind ? this.postKindHash(input.kind.key, now.data.key) : now.data.key;
		const theirs =
			movedHash === undefined ? undefined : buildCache.cached(store, projectKey, platform, movedHash, input.now());
		if (movedHash !== undefined && theirs) {
			input.log(`the checkout was built meanwhile (now ${now.data.key}): using that build`);
			this.onPostKey(movedHash);
			return resultFactory.ok({ kind: "cached", path: theirs.path });
		}
		return resultFactory.err(
			`the ${platform} checkout changed since it was fingerprinted (${verified} → ${now.data.key}): another build or an edit; run again`
		);
	}

	/** Run the local build (under the tree lock), its output mirrored to a live log under `liveKeys`; cache it, alias a re-key. */
	private async buildHere(liveKeys: string[]): AsyncResult<BuildStepOutcome> {
		const { input } = this;
		const { project, platform } = input;
		input.onPhase?.({ phase: "building", platform, hash: input.kind?.buildKey ?? input.hash });
		const live = liveLogs.open(input, liveKeys);
		const output = (line: string) => {
			live.write(line);
			input.buildOutput?.(line);
		};
		let built: Awaited<ReturnType<LocalBuilder["run"]>>;
		try {
			built = await new LocalBuilder({
				exec: input.exec,
				project,
				platform,
				hash: input.kind?.buildKey ?? input.hash,
				...(input.native !== undefined ? { native: input.native } : {}),
				env: input.env,
				log: input.log,
				output,
				...(project.compilerCache === false ? { compilerCache: false } : {}),
				...(input.git ? { git: input.git } : {}),
				prebuildStamp: prebuildStamps.of(input.store, project.root, platform),
			}).run();
		} finally {
			live.close();
		}
		if (!built.success) return built;
		const stored = await this.cache(built.data.artifact, "build", false);
		if (!stored.success) return stored;
		this.aliasPostKey(stored.data, built.data.postKey);
		return resultFactory.ok({ kind: "built", path: stored.data.path });
	}

	/**
	 * The local build step, cached under the requested key: every fresh checkout (and this session's other
	 * devices) computes it. A prebuild re-key (17-1) also aliases the post-build key and reports it. One build per
	 * checkout at a time (the tree lock): a second warden waits, mirroring the build's output, then takes its result.
	 */
	private buildStep(): NonNullable<ResolveSteps["build"]> {
		const { input } = this;
		const { project, platform } = input;
		const treeKey = buildLock.treeKey(this.realRoot(project.root), platform);
		const fpKey = buildLock.key(input.projectKey, platform, input.hash);
		const waitLine = (holder: string) => `another warden (${holder}) is building in ${project.root} — waiting`;
		const run = async (): AsyncResult<BuildStepOutcome> => {
			const meanwhile = await this.builtMeanwhile();
			if (!meanwhile.success) return meanwhile;
			return meanwhile.data ? resultFactory.ok(meanwhile.data) : this.buildHere([treeKey, fpKey]);
		};
		return () => this.lockFollowing(treeKey, run, waitLine);
	}

	/** The device target a kind key was made for, if any (only `dev` / `release` have one). */
	private deviceOf(key: KindBuildKey | undefined): DeviceTarget | undefined {
		return key?.kind === "dev" || key?.kind === "release" ? key.device : undefined;
	}
}

/**
 * Builds the `EnsureInput` of one kind build and runs it through `AppEnsurer`: construct with the `EnsureKindInput`,
 * call `ensure()`.
 *
 * `AppEnsurer` for one build of a kind, through the same cache / EAS / local-build / install pipeline: cached under
 * `kindDir`, keyed (cache, build lock, install record) by `kindHash(key)`, built with the kind's command and env
 * (`kinds.projectFor`). The legacy cache dirs are not consulted, and EAS never supplies the simulator base.
 */
export class KindBuildEnsurer {
	constructor(private readonly input: EnsureKindInput) {}

	async ensure(): AsyncResult<EnsureResult> {
		const { key, buildKey, project, ...rest } = this.input;
		const device = key.kind === "dev" || key.kind === "release" ? key.device : undefined;
		return new AppEnsurer({
			...rest,
			project: kinds.projectFor(project, buildCache.kindOfKey(key), device),
			hash: buildCache.kindHash(key),
			kind: { key, buildKey },
		}).ensure();
	}
}
