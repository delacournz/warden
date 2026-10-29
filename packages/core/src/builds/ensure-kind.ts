import { existsSync } from "node:fs";
import { join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { resolveTeam } from "../ios-runner/signing";
import type { Platform } from "../types";
import type { Project } from "./config";
import { type EnsureKindInput, ensureApp, ensureKindBuild } from "./ensure";
import { computeKindKey, SIMULATOR_ON_DEVICE } from "./kind-key";
import { type BuildKind, type DeviceTarget, deviceTarget, withDeviceBundleId } from "./kinds";
import { type RepackInput, repackApp } from "./repack";
import type { ApplyRepack } from "./repack.types";
import { androidRepacker, applyAndroidRepack } from "./repack-android";
import { applyIosRepack } from "./repack-ios";
import type { ResolveSource } from "./resolve";

/** What `prepareKindApp` / `ensureKindApp` need: a repack's input, the kind asked for and (to install) a device. */
export type KindAppInput = RepackInput & {
	/** the kind to put on the device */
	kind: BuildKind;
	/** udid / serial to install onto; absent = resolve the build into the cache only */
	deviceId?: string;
	/** `ios.teamId` of `warden.config.ts`: signs the build for a physical iPhone (`physical`), after `WARDEN_IOS_TEAM_ID` */
	configTeamId?: string;
};

type KindAppBase = {
	/** the kind that was asked for */
	requested: BuildKind;
	/** the cached `.app` / `.apk` */
	artifact: string;
	/** the cache / install hash (`kindHash`) */
	hash: string;
	source: ResolveSource | "repack";
	/** the app is on the device at `hash` (false without a device) */
	installed: boolean;
	/** set when the build is signed for a physical iPhone: its team, and the salt in `hash` */
	device?: DeviceTarget;
};

/**
 * The build a kind resolved to. `kind` is what was actually produced: a `simulator` request whose repack fell back
 * is a `release` build and carries `fallbackReason`.
 */
export type KindApp =
	| (KindAppBase & { kind: "dev" | "release"; fallbackReason?: string })
	| (KindAppBase & {
			kind: "simulator";
			repack: { jsKey: string; baseHash: string; reused: boolean; bundleMs?: number };
	  });

/** The effects `ensureKindApp` composes, injectable for tests. */
export type KindAppDeps = {
	repack: typeof repackApp;
	computeKeys: typeof computeKindKey;
	ensureBuild: typeof ensureKindBuild;
	ensureApp: typeof ensureApp;
};

const realDeps: KindAppDeps = {
	repack: repackApp,
	computeKeys: computeKindKey,
	ensureBuild: ensureKindBuild,
	ensureApp,
};

/** `input` as the plain build input `ensureKindBuild` takes. */
function buildInput(input: KindAppInput): Omit<EnsureKindInput, "key" | "buildKey"> {
	const {
		kind: _kind,
		repackers: _repackers,
		force: _force,
		hermes: _hermes,
		scratchRoot: _scratch,
		configTeamId: _team,
		...rest
	} = input;
	return rest;
}

/** `dev` / `release`: compute the kind's keys, then build (or find) it, no device involved. */
async function buildKind(
	input: KindAppInput,
	kind: "dev" | "release",
	requested: BuildKind,
	deps: KindAppDeps,
	fallbackReason?: string,
	device?: DeviceTarget
): AsyncResult<KindApp> {
	const { exec, project, platform } = input;
	const keys = await deps.computeKeys({
		exec,
		project,
		platform,
		kind,
		env: input.env,
		...(device ? { device } : {}),
	});
	if (!keys.success) return keys;
	const built = await deps.ensureBuild({
		...buildInput(input),
		key: keys.data.key,
		buildKey: keys.data.buildKey,
		native: keys.data.native,
	});
	if (!built.success) return built;
	return ok({
		kind,
		requested,
		artifact: built.data.appPath,
		hash: built.data.hash,
		source: built.data.source,
		installed: false,
		...(device ? { device } : {}),
		...(fallbackReason !== undefined ? { fallbackReason } : {}),
	});
}

/** The signing team of a build for a physical iPhone: `WARDEN_IOS_TEAM_ID`, `ios.teamId`, the keychain (never a guess between teams). */
async function resolveDevice(input: KindAppInput): AsyncResult<DeviceTarget> {
	const team = await resolveTeam({ configTeamId: input.configTeamId, env: input.env, exec: input.exec });
	if (!team.success) {
		const { code, message, hint } = team.error;
		const teams =
			team.error.code === "ios_team_ambiguous" ? ` (${team.error.teams.map((t) => t.teamId).join(", ")})` : "";
		return err(`${code}: ${message}${teams}. ${hint}`);
	}
	return ok(deviceTarget(input.project, team.data.team));
}

/**
 * Resolve `kind` into the cache without a device (the slow half, once per platform for a run): `dev` / `release` are
 * built or found; `simulator` is the repack of this worktree's JS over the cached base. A repack that cannot be
 * applied (`fallback`, e.g. Android `res/` images changed) builds the `release` kind instead and says why.
 */
export async function prepareKindApp(input: KindAppInput, deps: KindAppDeps = realDeps): AsyncResult<KindApp> {
	if (input.physical === true && input.platform === "ios") {
		// v1: a phone runs a build made for it (`dev` / `release`), never a simulator build or a repack of one
		if (input.kind === "simulator") return err(SIMULATOR_ON_DEVICE);
		const device = await resolveDevice(input);
		if (!device.success) return device;
		return buildKind(input, input.kind, input.kind, deps, undefined, device.data);
	}
	if (input.kind !== "simulator") return buildKind(input, input.kind, input.kind, deps);
	const packed = await deps.repack(input);
	if (!packed.success) return packed;
	const result = packed.data;
	if (result.kind === "fallback") {
		input.log(`repack not possible (${result.reason}): building the release kind instead`);
		return buildKind(input, "release", "simulator", deps, result.reason);
	}
	return ok({
		kind: "simulator",
		requested: "simulator",
		artifact: result.artifact,
		hash: result.hash,
		source: "repack",
		installed: false,
		repack: {
			jsKey: result.jsKey,
			baseHash: result.baseHash,
			reused: result.kind === "reused",
			...(result.bundleMs !== undefined ? { bundleMs: result.bundleMs } : {}),
		},
	});
}

/** Install a prepared kind build on `deviceId` (no build: it is in the cache at `app.hash`). */
export async function installKindApp(
	input: KindAppInput & { deviceId: string },
	app: KindApp,
	deps: KindAppDeps = realDeps
): AsyncResult<KindApp> {
	const { repackers: _r, force: _f, hermes: _h, scratchRoot: _s, kind: _k, ...rest } = input;
	const { configTeamId: _team, ...ids } = rest;
	// a build for a phone installs under the device bundle id (`projects[].ios.device.bundleIdentifier`)
	const project = app.device ? withDeviceBundleId(ids.project) : ids.project;
	const installed = await deps.ensureApp({ ...ids, project, hash: app.hash, build: false, eas: false });
	if (!installed.success) return installed;
	// `installed`: the device already ran this build, nothing was copied
	if (installed.data.installed) {
		return ok({
			...app,
			installed: true,
			...(installed.data.source === "installed" ? { source: "installed" as const } : {}),
		});
	}
	return err(`${app.kind} app ${app.hash} was not installed on ${input.deviceId}`);
}

/** `prepareKindApp`, then the install when a device is given: the one entry point every command uses. */
export async function ensureKindApp(input: KindAppInput, deps: KindAppDeps = realDeps): AsyncResult<KindApp> {
	const prepared = await prepareKindApp(input, deps);
	if (!prepared.success || input.deviceId === undefined) return prepared;
	return installKindApp({ ...input, deviceId: input.deviceId }, prepared.data, deps);
}

/**
 * Settings of `project` that contradict the requested `kind`, one line each. The kind decides the cache key: a
 * `fingerprint.include: "native+js"` project (the kind-less flow's JS-aware key) is keyed on native only for `dev`
 * and `simulator`, so its `jsInputs` are not what a repack or Metro run uses.
 */
export function kindWarnings(project: Project, kind: BuildKind): string[] {
	if (project.jsInputs === undefined || kind === "release") return [];
	const instead =
		kind === "simulator"
			? "set projects[].kinds.simulator.jsInputs to choose the JS sources a repack covers"
			: "a dev build is keyed on the native fingerprint only";
	return [
		`fingerprint.include "native+js" of project ${project.name} is ignored by --kind ${kind} (${instead}); drop fingerprint.include or use --kind release`,
	];
}

/**
 * The platform halves of a repack for the project at `root`. Android re-signs with the project's own
 * `android/app/debug.keystore` when it exists (the base was signed with it, so the repack keeps its signer),
 * else with the default debug keystore.
 */
export function projectRepackers(
	root: string,
	exists: (path: string) => boolean = existsSync
): Record<Platform, ApplyRepack> {
	const keystore = join(root, "android", "app", "debug.keystore");
	return {
		ios: applyIosRepack,
		android: exists(keystore)
			? androidRepacker({
					keystore: { path: keystore, alias: "androiddebugkey", storePass: "android", keyPass: "android" },
				})
			: applyAndroidRepack,
	};
}
