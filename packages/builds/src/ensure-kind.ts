import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildKind } from "@delacour/warden-config/build-kinds";
import { BuildsTable } from "@delacour/warden-store/builds-table";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { buildCache } from "./cache";
import type { Project } from "./config";
import { AppEnsurer, type EnsureInput, type EnsureKindInput, KindBuildEnsurer } from "./ensure";
import { signing } from "./ios-runner/signing";
import { type KindKeyDeps, type KindKeys, kindKeyResolver, SIMULATOR_ON_DEVICE } from "./kind-key";
import { type DeviceTarget, kinds } from "./kinds";
import { Repacker, type RepackInput, type RepackResult } from "./repack";
import type { ApplyRepack } from "./repack.types";
import { AndroidRepacker, androidRepacker } from "./repack-android";
import { iosRepacker } from "./repack-ios";
import type { EnsureResult, ResolveSource } from "./resolve";

/** What `KindApps.prepare` / `KindApps.ensure` need: a repack's input, the kind asked for and (to install) a device. */
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

/** The effects `KindApps` composes, injectable for tests. */
export type KindAppDeps = {
	repack: (input: RepackInput) => AsyncResult<RepackResult>;
	computeKeys: (deps: KindKeyDeps) => AsyncResult<KindKeys>;
	ensureBuild: (input: EnsureKindInput) => AsyncResult<EnsureResult>;
	ensureApp: (input: EnsureInput) => AsyncResult<EnsureResult>;
};

const realDeps: KindAppDeps = {
	repack: (input) => new Repacker(input).run(),
	computeKeys: (deps) => kindKeyResolver.compute(deps),
	ensureBuild: (input) => new KindBuildEnsurer(input).ensure(),
	ensureApp: (input) => new AppEnsurer(input).ensure(),
};

const REGISTER_TIMEOUT_MS = 20 * 60_000;
const NOT_IN_PROFILE_CODE = "device_not_in_profile";
const GENERIC_DESTINATION = "-destination generic/platform=iOS";

/**
 * Resolve, install and warn about a kind's app. Instance class over one `KindAppDeps` bag (the real effects by
 * default, a fake in tests): `prepare` / `install` / `ensure` are the old `prepareKindApp` / `installKindApp` /
 * `ensureKindApp`; `warnings` and `repackers` are pure helpers (use the shared `kindApps` singleton).
 */
export class KindApps {
	constructor(private readonly deps: KindAppDeps = realDeps) {}

	/** `input` as the plain build input `ensureKindBuild` takes. */
	private buildInput(input: KindAppInput): Omit<EnsureKindInput, "key" | "buildKey"> {
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
	private async buildKind(
		input: KindAppInput,
		kind: "dev" | "release",
		requested: BuildKind,
		fallbackReason?: string,
		device?: DeviceTarget
	): AsyncResult<KindApp> {
		const { exec, project, platform } = input;
		const keys = await this.deps.computeKeys({
			exec,
			project,
			platform,
			kind,
			env: input.env,
			...(device ? { device } : {}),
		});
		if (!keys.success) return keys;
		const built = await this.deps.ensureBuild({
			...this.buildInput(input),
			key: keys.data.key,
			buildKey: keys.data.buildKey,
			native: keys.data.native,
		});
		if (!built.success) return built;
		return resultFactory.ok({
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
	private async resolveDevice(input: KindAppInput): AsyncResult<DeviceTarget> {
		const team = await signing.resolveTeam({ configTeamId: input.configTeamId, env: input.env, exec: input.exec });
		if (!team.success) {
			const { code, message, hint } = team.error;
			const teams =
				team.error.code === "ios_team_ambiguous" ? ` (${team.error.teams.map((t) => t.teamId).join(", ")})` : "";
			return resultFactory.err(`${code}: ${message}${teams}. ${hint}`);
		}
		return resultFactory.ok(kinds.deviceTarget(input.project, team.data.team));
	}

	/**
	 * Resolve `kind` into the cache without a device (the slow half, once per platform for a run): `dev` / `release` are
	 * built or found; `simulator` is the repack of this worktree's JS over the cached base. A repack that cannot be
	 * applied (`fallback`, e.g. Android `res/` images changed) builds the `release` kind instead and says why.
	 */
	async prepare(input: KindAppInput): AsyncResult<KindApp> {
		if (input.physical === true && input.platform === "ios") {
			// v1: a phone runs a build made for it (`dev` / `release`), never a simulator build or a repack of one
			if (input.kind === "simulator") return resultFactory.err(SIMULATOR_ON_DEVICE);
			const device = await this.resolveDevice(input);
			if (!device.success) return device;
			return this.buildKind(input, input.kind, input.kind, undefined, device.data);
		}
		if (input.kind !== "simulator") return this.buildKind(input, input.kind, input.kind);
		const packed = await this.deps.repack(input);
		if (!packed.success) return packed;
		const result = packed.data;
		if (result.kind === "fallback") {
			input.log(`repack not possible (${result.reason}): building the release kind instead`);
			return this.buildKind(input, "release", "simulator", result.reason);
		}
		return resultFactory.ok({
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

	/** Where the UDIDs registered for a cached device build are listed: beside the build, else under the builds root. */
	private registeredFile(input: KindAppInput, hash: string): string {
		const record = new BuildsTable(input.store).get(input.projectKey, input.platform, hash);
		return record
			? join(dirname(record.path), "devices.json")
			: join(buildCache.root(input.env), "devices", `${input.projectKey.replace(/[^\w.-]/g, "_")}-${hash}.json`);
	}

	private readRegistered(file: string): string[] {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
		} catch {
			return [];
		}
	}

	private writeRegistered(file: string, udids: readonly string[]): void {
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify([...new Set(udids)])}\n`);
		} catch {
			// best effort: a missing record only means one more registration attempt
		}
	}

	/**
	 * An install that failed because the build's provisioning profile does not list the phone: build once for that
	 * phone (`-destination id=<udid>` under `-allowProvisioningUpdates` registers the UDID with the team and regenerates
	 * the automatic profile), drop the cached build (its embedded profile is stale), rebuild it under the same key and
	 * install once more. A phone registered before, or a build command that is not warden's, gets the original error.
	 */
	private async registerPhone(
		input: KindAppInput & { deviceId: string },
		app: KindApp,
		failure: string
	): AsyncResult<KindApp> {
		if (app.kind === "simulator" || !app.device) return resultFactory.err(failure);
		const file = this.registeredFile(input, app.hash);
		const known = this.readRegistered(file);
		if (known.includes(input.deviceId)) return resultFactory.err(failure);
		const build = kinds.projectFor(input.project, app.kind, app.device).build.ios;
		if (!build.includes(GENERIC_DESTINATION)) return resultFactory.err(failure);
		input.log(`${input.deviceId} is not in the app's provisioning profile: registering it with a build for this phone`);
		const command = build.replaceAll(GENERIC_DESTINATION, `-destination id=${input.deviceId}`);
		const res = await input.exec(["sh", "-c", command], {
			cwd: input.project.root,
			env: { ...input.project.buildEnv, EXPO_NO_TELEMETRY: "1" },
			timeoutMs: REGISTER_TIMEOUT_MS,
		});
		if (res.exitCode !== 0) {
			const line = `${res.stderr}\n${res.stdout}`.split("\n").find((l) => /error:/i.test(l)) ?? `exit ${res.exitCode}`;
			return resultFactory.err(`${failure}. Registering the phone with a build for it failed: ${line.trim()}`);
		}
		const stale = new BuildsTable(input.store).get(input.projectKey, input.platform, app.hash);
		if (stale) buildCache.remove(input.store, input.env, stale);
		const rebuilt = await this.prepare({ ...input, physical: true });
		if (!rebuilt.success) return rebuilt;
		const installed = await this.installOnce(input, rebuilt.data);
		if (!installed.success) return installed;
		this.writeRegistered(this.registeredFile(input, rebuilt.data.hash), [...known, input.deviceId]);
		return installed;
	}

	/** One install of a prepared build (no recovery). */
	private async installOnce(input: KindAppInput & { deviceId: string }, app: KindApp): AsyncResult<KindApp> {
		const { repackers: _r, force: _f, hermes: _h, scratchRoot: _s, kind: _k, ...rest } = input;
		const { configTeamId: _team, ...ids } = rest;
		// a build for a phone installs under the device bundle id (`projects[].ios.device.bundleIdentifier`)
		const project = app.device ? kinds.withDeviceBundleId(ids.project) : ids.project;
		const installed = await this.deps.ensureApp({ ...ids, project, hash: app.hash, build: false, eas: false });
		if (!installed.success) return installed;
		// `installed`: the device already ran this build, nothing was copied
		if (installed.data.installed) {
			return resultFactory.ok({
				...app,
				installed: true,
				...(installed.data.source === "installed" ? { source: "installed" as const } : {}),
			});
		}
		return resultFactory.err(`${app.kind} app ${app.hash} was not installed on ${input.deviceId}`);
	}

	/** Install a prepared kind build on `deviceId` (no build: it is in the cache at `app.hash`); a phone missing from the profile is registered once. */
	async install(input: KindAppInput & { deviceId: string }, app: KindApp): AsyncResult<KindApp> {
		const installed = await this.installOnce(input, app);
		if (installed.success || input.platform !== "ios" || !installed.error.includes(NOT_IN_PROFILE_CODE)) {
			return installed;
		}
		return this.registerPhone(input, app, installed.error);
	}

	/** `prepare`, then the install when a device is given: the one entry point every command uses. */
	async ensure(input: KindAppInput): AsyncResult<KindApp> {
		const prepared = await this.prepare(input);
		if (!prepared.success || input.deviceId === undefined) return prepared;
		return this.install({ ...input, deviceId: input.deviceId }, prepared.data);
	}

	/**
	 * Settings of `project` that contradict the requested `kind`, one line each. The kind decides the cache key: a
	 * `fingerprint.include: "native+js"` project (the kind-less flow's JS-aware key) is keyed on native only for `dev`
	 * and `simulator`, so its `jsInputs` are not what a repack or Metro run uses.
	 */
	warnings(project: Project, kind: BuildKind): string[] {
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
	repackers(root: string, exists: (path: string) => boolean = existsSync): Record<Platform, ApplyRepack> {
		const keystore = join(root, "android", "app", "debug.keystore");
		return {
			ios: iosRepacker.apply,
			android: exists(keystore)
				? new AndroidRepacker({
						keystore: { path: keystore, alias: "androiddebugkey", storePass: "android", keyPass: "android" },
					}).apply
				: androidRepacker.apply,
		};
	}
}

/** The real-effects instance: use it for `warnings` / `repackers` and wherever no deps are injected. */
export const kindApps = new KindApps();
