import { type AsyncResult, ok } from "@warden/types/result";
import type { Exec } from "../exec";
import type { PidAlive } from "../liveness";
import type { Store } from "../store";
import type { Owner, Platform } from "../types";
import { type BuildSource, cachedBuild, findLegacyArtifact, getInstall, recordInstall, storeArtifact } from "./cache";
import { bundleIdFor, loadProject, type Project } from "./config";
import { type Download, resolveFromEas } from "./eas";
import { installApp, isAppInstalled } from "./install";
import { runLocalBuild } from "./local";
import { buildLockKey, withBuildLock } from "./lock";
import { readProjectKey } from "./project-key";
import { type EnsureResult, type ResolveSteps, resolveApp } from "./resolve";

/** Cache `profile` for builds with no EAS profile (local / imported only). */
export const LOCAL_PROFILE = "local";

export type ProjectContext = { project: Project; projectKey: string };

export type ProjectContextInput = {
	exec: Exec;
	env: Record<string, string | undefined>;
	/** `--project` dir or cwd */
	start: string;
	name?: string;
	bundleId?: Project["bundleId"];
};

/** Load the project for `start` (bounded by its git toplevel) and compute its project key. */
export async function projectContext(input: ProjectContextInput): AsyncResult<ProjectContext> {
	const top = await input.exec(["git", "rev-parse", "--show-toplevel"], { cwd: input.start });
	const stopAt = top.exitCode === 0 && top.stdout.trim() ? top.stdout.trim() : undefined;
	const project = loadProject({
		start: input.start,
		env: input.env,
		...(stopAt ? { stopAt } : {}),
		...(input.name !== undefined ? { name: input.name } : {}),
		...(input.bundleId ? { bundleId: input.bundleId } : {}),
	});
	if (!project.success) return project;
	const key = await readProjectKey(input.exec, project.data.root);
	if (!key.success) return key;
	return ok({ project: project.data, projectKey: key.data });
}

export type EnsureInput = ProjectContext & {
	store: Store;
	exec: Exec;
	env: Record<string, string | undefined>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
	pidAlive: PidAlive;
	/** owner + pid of the build lock */
	owner: Owner;
	pid: number;
	platform: Platform;
	hash: string;
	/** udid / serial to install onto; absent = resolve the artifact only */
	deviceId?: string;
	/** false = `--no-eas` */
	eas: boolean;
	/** false = `--no-build` */
	build: boolean;
	download?: Download;
	easPollMs?: number;
	lockPollMs?: number;
};

function profileOf(project: Project): string {
	return project.eas?.profile ?? LOCAL_PROFILE;
}

/** Wire the real effects (sqlite cache, simctl/adb, eas-cli, local build) into `resolveApp`. */
export async function ensureApp(input: EnsureInput): AsyncResult<EnsureResult> {
	const { store, env, project, projectKey, platform, hash } = input;
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
			now: input.now(),
		});

	const steps: ResolveSteps = {
		hash,
		log: input.log,
		cached: () => cachedBuild(store, projectKey, platform, hash, input.now())?.path,
		legacy: async () => {
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
	if (input.eas && easSettings) {
		steps.eas = async () => {
			const outcome = await resolveFromEas({
				exec: input.exec,
				cwd: project.root,
				platform,
				hash,
				eas: easSettings,
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
	if (input.build) {
		steps.build = async () => {
			const built = await runLocalBuild({
				exec: input.exec,
				project,
				platform,
				hash,
				env,
				now: input.now,
				log: input.log,
			});
			if (!built.success) return built;
			const stored = await cache(built.data, "build", false);
			return stored.success ? ok(stored.data.path) : stored;
		};
	}

	const deviceId = input.deviceId;
	if (deviceId !== undefined) {
		const bundleId = bundleIdFor(project, platform);
		if (!bundleId.success) return bundleId;
		const target = { platform, deviceId };
		const deps = { exec: input.exec, env };
		steps.device = {
			installedHash: () => getInstall(store, platform, deviceId, bundleId.data)?.hash,
			confirm: () => isAppInstalled(deps, target, bundleId.data),
			install: async (appPath) => {
				input.log(`installing ${appPath} on ${deviceId}`);
				const done = await installApp(deps, target, appPath, bundleId.data);
				if (done.success) {
					recordInstall(store, { platform, deviceId, bundleId: bundleId.data, hash, installedAt: input.now() });
				}
				return done;
			},
		};
	}
	return resolveApp(steps);
}
