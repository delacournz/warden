import { join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import { type GitFactsCache, readGitFacts } from "../git-facts";
import type { PidAlive } from "../liveness";
import type { Store } from "../store";
import type { Owner, Platform } from "../types";
import { readExpoConfig } from "./app-config";
import type { InstallMode } from "./app-option.schema";
import {
	aliasBuild,
	type BuildSource,
	buildKindOfKey,
	buildsRoot,
	cachedBuild,
	findLegacyArtifact,
	getBuild,
	getInstall,
	type KindKey,
	kindDir,
	kindHash,
	recordInstall,
	storeArtifact,
} from "./cache";
import { appStart, bundleIdFor, dynamicAppConfigDir, type EasSettings, loadProject, type Project } from "./config";
import { type Download, resolveFromEas } from "./eas";
import {
	appMatchesArtifact,
	executableStamp,
	type FileSize,
	type FileStamp,
	installAndProbe,
	nodeResetFs,
	probeApp,
	type ResetFs,
	resetAppData,
	resetSimKeychain,
	uninstallApp,
} from "./install";
import { projectForKind } from "./kinds";
import { type PrebuildStamp, runLocalBuild } from "./local";
import { buildLockKey, withBuildLock } from "./lock";
import { overlayDirUnlessRepoConfig } from "./overlay";
import { readProjectKey } from "./project-key";
import { type AppPhase, type EnsureResult, type ResolveSteps, resolveApp } from "./resolve";

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

/** Load the project for `start` (bounded by its git toplevel) and compute its project key. */
export async function projectContext(input: ProjectContextInput): AsyncResult<ProjectContext> {
	const facts = await readGitFacts(input.exec, input.start, input.git);
	const stopAt = facts?.toplevel;
	const overlay = await overlayDirUnlessRepoConfig(input.exec, input.start, stopAt, input.env, input.git);
	// a monorepo root with one app below it: look the project up from that app
	const start = appStart(input.start, stopAt, overlay);
	const load = {
		start,
		env: input.env,
		...(stopAt ? { stopAt } : {}),
		...(overlay ? { overlayDir: overlay } : {}),
		...(input.name !== undefined ? { name: input.name } : {}),
		...(input.bundleId ? { bundleId: input.bundleId } : {}),
		...(input.variant !== undefined ? { variant: input.variant } : {}),
		...(input.variantOptional ? { variantOptional: true } : {}),
	};
	let appConfig: ProjectContext["appConfig"];
	let project = loadProject(load);
	if (!project.success) {
		const dynamicDir = dynamicAppConfigDir(start, stopAt, input.bundleId, overlay);
		if (dynamicDir === undefined) return project;
		// the app's config is code: only Expo can resolve it, so ask Expo once and detect again with its answer
		const read = await readExpoConfig(input.exec, dynamicDir);
		if (!read.success) return err(`${project.error}; ${read.error}`);
		appConfig = {
			...(read.data.slug ? { slug: read.data.slug } : {}),
			...(read.data.scheme ? { scheme: read.data.scheme } : {}),
		};
		project = loadProject({
			...load,
			bundleId: { ...read.data.bundleId, ...input.bundleId },
			...(read.data.slug ? { appName: read.data.slug } : {}),
		});
		if (!project.success) return project;
	}
	const key = await readProjectKey(input.exec, project.data.root, input.git);
	if (!key.success) return key;
	return ok({ project: project.data, projectKey: key.data, ...(appConfig ? { appConfig } : {}) });
}

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
	/** file sizes for the installed-app identity check (default node:fs) */
	fileSize?: FileSize;
	/** `ino:mtime` of the installed executable, recorded at install to skip that check (default node:fs) */
	fileStamp?: FileStamp;
	download?: Download;
	easPollMs?: number;
	lockPollMs?: number;
	/** per-command memo of the git facts, shared with `projectContext` (default: a short-lived shared one) */
	git?: GitFactsCache;
	/** progress for a spinner: fetching / waiting / building / installing / ready (`AppPhase`) */
	onPhase?: (phase: AppPhase) => void;
	/** set by `ensureKindBuild`: the build goes into its kind dir and a local build is verified against `buildKey` */
	kind?: { key: KindBuildKey; buildKey: string };
};

/** The kind builds `ensureKindBuild` makes: a repack is made from a base by the repack engine, never built. */
export type KindBuildKey = Exclude<KindKey, { kind: "simulator-repack" }>;

/**
 * HEAD's sha when the working tree is clean. A JS-aware key covers JS the EAS fingerprint doesn't, so
 * EAS can only be trusted for a build of the exact commit being tested — dirty tree, no EAS.
 */
async function cleanHead(exec: Exec, cwd: string): AsyncResult<string> {
	const status = await exec(["git", "status", "--porcelain"], { cwd });
	if (status.exitCode !== 0) return err("EAS skipped: not a git checkout");
	if (status.stdout.trim() !== "") return err("EAS skipped: working tree is not clean (JS-aware key)");
	const head = await exec(["git", "rev-parse", "HEAD"], { cwd });
	const sha = head.stdout.trim();
	return head.exitCode === 0 && sha ? ok(sha) : err("EAS skipped: could not read HEAD");
}

/** Cache `profile`: the EAS profile (or `local`), `:<variant>` / `:<kind>` when the project was resolved with one. */
function profileOf(project: Project): string {
	const profile = project.eas?.profile ?? LOCAL_PROFILE;
	if (project.variant !== undefined) return `${profile}:${project.variant}`;
	return project.kind === undefined ? profile : `${profile}:${project.kind}`;
}

/**
 * The cache key a prebuild re-key (17-1) gives a kind build. `dev` and the simulator base are keyed by the build key
 * itself, so the re-keyed build is the same kind of build at `postKey`; a `release` key mixes in the JS and cannot be
 * rebuilt from `postKey` alone (no alias: the next run misses once and builds again).
 */
function postKindHash(key: KindBuildKey, postKey: string): string | undefined {
	return key.kind === "release" ? undefined : kindHash({ kind: key.kind, nativeFp: postKey });
}

/** The store's record of the native fingerprint `<root>/<platform>` was last prebuilt for (a CNG dir is per checkout). */
export function prebuildStamp(store: Store, root: string, platform: Platform): PrebuildStamp {
	const key = `prebuild:${platform}:${join(root, platform)}`;
	return { read: () => store.getMeta(key), write: (native) => store.setMeta(key, native) };
}

type CacheFn = (path: string, source: BuildSource, move: boolean) => ReturnType<typeof storeArtifact>;

/** The EAS step: JS-aware projects look builds up by (clean) HEAD commit, the rest by fingerprint hash. */
function easStep(input: EnsureInput, eas: EasSettings, cache: CacheFn): NonNullable<ResolveSteps["eas"]> {
	const { project, platform } = input;
	const hash = input.native ?? input.hash;
	return async () => {
		const head = project.jsInputs === undefined ? undefined : await cleanHead(input.exec, project.root);
		if (head && !head.success) return ok({ kind: "miss", reason: head.error });
		input.onPhase?.({ phase: "fetching", source: "eas" });
		const outcome = await resolveFromEas({
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
		});
		if (outcome.kind === "miss") return ok(outcome);
		const stored = await cache(outcome.path, "eas", true);
		return stored.success ? ok({ kind: "hit", path: stored.data.path }) : stored;
	};
}

/** A prebuild re-key (17-1): alias the build under the post-build key and report it, when there is one to alias. */
function aliasPostKey(
	input: EnsureInput,
	stored: Parameters<typeof aliasBuild>[1],
	postKey: string | undefined,
	onPostKey: (postKey: string) => void
): void {
	if (postKey === undefined) return;
	const aliasHash = input.kind ? postKindHash(input.kind.key, postKey) : postKey;
	if (aliasHash === undefined) return;
	aliasBuild(input.store, stored, aliasHash, input.now());
	onPostKey(aliasHash);
}

/**
 * The local build step, cached under the requested key: every fresh checkout (and this session's other
 * devices) computes it. A prebuild re-key (17-1) also aliases the post-build key and reports it.
 */
function buildStep(
	input: EnsureInput,
	cache: CacheFn,
	onPostKey: (postKey: string) => void
): NonNullable<ResolveSteps["build"]> {
	const { project } = input;
	return async () => {
		input.onPhase?.({ phase: "building", platform: input.platform, hash: input.kind?.buildKey ?? input.hash });
		const built = await runLocalBuild({
			exec: input.exec,
			project,
			platform: input.platform,
			hash: input.kind?.buildKey ?? input.hash,
			...(input.native !== undefined ? { native: input.native } : {}),
			env: input.env,
			log: input.log,
			...(input.buildOutput ? { output: input.buildOutput } : {}),
			...(project.compilerCache === false ? { compilerCache: false } : {}),
			...(input.git ? { git: input.git } : {}),
			prebuildStamp: prebuildStamp(input.store, project.root, input.platform),
		});
		if (!built.success) return built;
		const stored = await cache(built.data.artifact, "build", false);
		if (!stored.success) return stored;
		aliasPostKey(input, stored.data, built.data.postKey, onPostKey);
		return ok(stored.data.path);
	};
}

/** Wire the real effects (sqlite cache, simctl/adb, eas-cli, local build) into `resolveApp`. */
export async function ensureApp(input: EnsureInput): AsyncResult<EnsureResult> {
	const { store, env, project, projectKey, platform, hash } = input;
	const layout = input.kind && {
		dir: kindDir(env, projectKey, platform, input.kind.key),
		kind:
			input.kind.key.kind === "release"
				? { kind: "release" as const, jsKey: input.kind.key.jsKey }
				: input.kind.key.kind,
	};
	const cache = (path: string, source: BuildSource, move: boolean) =>
		storeArtifact({
			store,
			env,
			projectKey,
			platform,
			profile: profileOf(project),
			hash,
			artifact: path,
			source,
			move,
			...(layout ? { layout } : {}),
			now: input.now(),
		});

	/** the key later runs in this checkout compute: the post-prebuild key once this call's build re-keyed (17-1) */
	let installKey = hash;
	/** an install at `recorded` is this build when both keys name the same cached files (an alias) */
	const installedAt = (recorded: string | undefined) => {
		if (recorded === undefined || recorded === hash) return recorded;
		const mine = getBuild(store, projectKey, platform, hash)?.path;
		return mine !== undefined && getBuild(store, projectKey, platform, recorded)?.path === mine ? hash : recorded;
	};

	const steps: ResolveSteps = {
		hash,
		flightKey: `${buildsRoot(env)}|${buildLockKey(projectKey, platform, hash)}`,
		...(input.installMode !== undefined ? { installMode: input.installMode } : {}),
		log: input.log,
		...(input.onPhase ? { onPhase: input.onPhase } : {}),
		cached: () => cachedBuild(store, projectKey, platform, hash, input.now())?.path,
		legacy: async () => {
			if (input.kind) return ok(undefined);
			const found = findLegacyArtifact(project.cacheDirs, platform, hash);
			if (!found) return ok(undefined);
			const stored = await cache(found, "legacy", false);
			return stored.success ? ok(stored.data.path) : stored;
		},
		lock: (fn) =>
			withBuildLock(
				{
					store,
					owner: input.owner,
					pid: input.pid,
					now: input.now,
					pidAlive: input.pidAlive,
					sleep: input.sleep,
					log: input.log,
					...(input.lockPollMs !== undefined ? { pollMs: input.lockPollMs } : {}),
				},
				buildLockKey(projectKey, platform, hash),
				fn
			),
	};

	const easSettings = project.eas;
	// an EAS build is a dev or release build: it can never be the simulator base, whose point is carrying no JS bundle
	const easApplies = input.kind?.key.kind !== "simulator-base";
	if (input.eas && easSettings && easApplies) steps.eas = easStep(input, easSettings, cache);
	if (input.build) {
		steps.build = buildStep(input, cache, (postKey) => {
			installKey = postKey;
		});
	}

	const deviceId = input.deviceId;
	if (deviceId !== undefined) {
		const bundleId = bundleIdFor(project, platform);
		if (!bundleId.success) return bundleId;
		const target = { platform, deviceId };
		const deps = { exec: input.exec, env, ...(input.fileSize ? { fileSize: input.fileSize } : {}) };
		steps.device = {
			installedHash: () => installedAt(getInstall(store, platform, deviceId, bundleId.data)?.hash),
			confirm: () => probeApp(deps, target, bundleId.data),
			matches: async (cachedPath, installed) => {
				// the container this process recorded at install, executable untouched: that install (17-7, no plutil)
				const record = getInstall(store, platform, deviceId, bundleId.data);
				const container = installed.container;
				if (container !== undefined && record?.container === container && record.exeStamp !== undefined) {
					if ((await executableStamp(container, input.fileStamp)) === record.exeStamp) return ok(true);
				}
				return appMatchesArtifact(deps, target, bundleId.data, cachedPath, container);
			},
			uninstall: async () => {
				input.log(`uninstalling ${bundleId.data} from ${deviceId} (${input.installMode ?? "reinstall"})`);
				const gone = await uninstallApp(deps, target, bundleId.data);
				return gone.success && input.resetKeychain ? resetSimKeychain(deps, target) : gone;
			},
			reset: () => {
				input.log(`resetting ${bundleId.data} data on ${deviceId} (clean)`);
				const fs = input.resetFs ?? nodeResetFs;
				return resetAppData({ ...deps, fs }, target, bundleId.data, { keychain: input.resetKeychain === true });
			},
			install: async (appPath) => {
				input.log(`installing ${appPath} on ${deviceId}`);
				const done = await installAndProbe(deps, target, appPath, bundleId.data);
				if (!done.success) return done;
				const { container } = done.data;
				const exeStamp = container === undefined ? undefined : await executableStamp(container, input.fileStamp);
				recordInstall(store, {
					platform,
					deviceId,
					bundleId: bundleId.data,
					hash: installKey,
					installedAt: input.now(),
					...(container !== undefined ? { container } : {}),
					...(exeStamp !== undefined ? { exeStamp } : {}),
				});
				return ok(undefined);
			},
		};
	}
	return resolveApp(steps);
}

export type EnsureKindInput = Omit<EnsureInput, "hash" | "kind" | "project"> & {
	/** the project as loaded (kind-less); `ensureKindBuild` resolves it as the kind of `key` */
	project: Project;
	/** which build: `dev`, the `simulator-base`, or a `release` (a repack is made from a base, not built) */
	key: KindBuildKey;
	/** the key `computeCacheKey` gives the kind's project: what a local build is verified against (`computeKindKey().buildKey`) */
	buildKey: string;
};

/**
 * `ensureApp` for one build of a kind, through the same cache / EAS / local-build / install pipeline: cached under
 * `kindDir`, keyed (cache, build lock, install record) by `kindHash(key)`, built with the kind's command and env
 * (`projectForKind`). The legacy cache dirs are not consulted, and EAS never supplies the simulator base.
 */
export async function ensureKindBuild(input: EnsureKindInput): AsyncResult<EnsureResult> {
	const { key, buildKey, project, ...rest } = input;
	return ensureApp({
		...rest,
		project: projectForKind(project, buildKindOfKey(key)),
		hash: kindHash(key),
		kind: { key, buildKey },
	});
}
