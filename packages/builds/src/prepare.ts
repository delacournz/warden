import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { InstallMode } from "@delacour/warden-config/app-option.schema";
import { BUILD_KINDS, type BuildKind } from "@delacour/warden-config/build-kinds";
import type { GitFactsCache } from "@delacour/warden-runtime/git-facts";
import { processAlive } from "@delacour/warden-store/liveness";
import type { Store } from "@delacour/warden-store/store";
import type { Owner, Platform } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import type { WardenHost } from "@delacour/warden-types/host";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { findWardenConfig } from "./config";
import { type EnsureInput, ensureApp, type ProjectContext, type ProjectContextInput, projectContext } from "./ensure";
import {
	installKindApp,
	type KindApp,
	type KindAppInput,
	kindWarnings,
	prepareKindApp,
	projectRepackers,
} from "./ensure-kind";
import { type CacheKey, computeCacheKey } from "./fingerprint";
import type { ApplyRepack } from "./repack.types";
import type { AppPhase, EnsureResult } from "./resolve";

/** What app preparation needs from the outside world: the host plus the shared store and git-facts memo. */
export type AppHost = WardenHost & { store: () => Store; git: GitFactsCache };

/** Effects an ensure needs beyond the host, injectable for tests. */
export type AppDeps = {
	/** pid recorded on the build lock */
	pid: number;
	sleep: (ms: number) => Promise<void>;
	pidAlive: (pid: number) => boolean;
	easPollMs?: number;
	lockPollMs?: number;
	/** the platform halves of a repack (default: the real iOS / Android repackers) */
	repackers?: Record<Platform, ApplyRepack>;
};

export const defaultAppDeps: AppDeps = { pid: process.pid, sleep: (ms) => Bun.sleep(ms), pidAlive: processAlive };

/** `--kind <dev|simulator|release>` values. */
export function parseKind(value: string): Result<BuildKind, WardenError> {
	const kind = BUILD_KINDS.find((k) => k === value);
	return kind
		? resultFactory.ok(kind)
		: wardenErrors.err("usage", `--kind ${value}: expected ${BUILD_KINDS.join(" | ")}`);
}

/** Project + cache options shared by `app ensure` and `run --app`. */
export type EnsureOptions = {
	/** `--project` dir (relative to cwd) */
	project?: string;
	bundleId?: string;
	/** false = `--no-eas` */
	eas: boolean;
	/** false = `--no-build` */
	build: boolean;
	/** `--install-mode`: reset the installed app first (`clean`: fresh data, `reinstall`: uninstall + install) */
	installMode?: InstallMode;
	/** `--reset-keychain`: also reset the iOS sim keychain (needs `installMode`) */
	resetKeychain?: boolean;
	/** `--variant`: a `projects[].variants.<name>` build */
	variant?: string;
	/** `--kind`: install this build kind (`simulator` = the repacked sim build) instead of the project's kind-less build; not with `variant` */
	kind?: BuildKind;
	/** env the JS is bundled with for the kinds that embed it (`simulator`, `release`): `warden e2e` passes the suite's `metro.env` */
	bundleEnv?: Record<string, string>;
	/** `--force` of `warden repack`: rebuild the repack even when this JS is cached */
	force?: boolean;
	/** a missing variant falls back to the project's own build (`warden dev`) */
	variantOptional?: boolean;
	/** the device is a real phone: an Android install checks the APK's ABIs first (`abi_mismatch`); set per device by the lease session */
	physical?: boolean;
	/** progress for a spinner: what the resolve is doing (`AppPhase`) */
	onPhase?: (phase: AppPhase) => void;
	/** a local build's own output, line by line, while it runs (`warden dev`'s dashboard); unset = only the failure summary */
	buildOutput?: (line: string) => void;
};

function log(host: AppHost, line: string): void {
	host.log?.({ kind: "progress", phase: "app", message: line });
}

/** Where project discovery starts: `project` (relative to cwd, must be a directory) or cwd. */
export function projectStart(host: Pick<AppHost, "cwd">, project: string | undefined): Result<string> {
	if (!project) return resultFactory.ok(host.cwd);
	const start = resolve(host.cwd, project);
	return statSync(start, { throwIfNoEntry: false })?.isDirectory()
		? resultFactory.ok(start)
		: resultFactory.err(`--project ${project}: no such directory ${start} (cwd ${host.cwd})`);
}

/** `projectContext` with the host's exec, env and git cache, so the project lookup shares the git facts of the whole command. */
export function projectContextFor(
	host: Pick<AppHost, "exec" | "env" | "git">,
	input: Omit<ProjectContextInput, "exec" | "env" | "git">
): AsyncResult<ProjectContext> {
	return projectContext({ exec: host.exec, env: host.env, git: host.git, ...input });
}

/** Load the project the options name: `--project`, bundle id override (per platform), variant. */
export async function loadProject(
	host: AppHost,
	opts: Pick<EnsureOptions, "project" | "bundleId" | "variant" | "variantOptional">,
	platform?: Platform
): AsyncResult<ProjectContext> {
	const start = projectStart(host, opts.project);
	if (!start.success) return start;
	const bundleId = opts.bundleId !== undefined && platform !== undefined ? { [platform]: opts.bundleId } : undefined;
	return projectContextFor(host, {
		start: start.data,
		...(bundleId ? { bundleId } : {}),
		...(opts.variant !== undefined ? { variant: opts.variant } : {}),
		...(opts.variantOptional ? { variantOptional: true } : {}),
	});
}

/** Cache key, announced loudly through the host (a hash that differs from EAS's never finds a build). */
export async function fingerprint(host: AppHost, project: ProjectContext, platform: Platform): AsyncResult<CacheKey> {
	const hash = await computeCacheKey(
		host.exec,
		project.project,
		platform,
		undefined,
		{ store: host.store(), now: host.now() },
		host.env
	);
	if (!hash.success) return hash;
	host.log?.({
		kind: "fingerprint",
		platform,
		key: hash.data.key,
		...(hash.data.js !== undefined ? { native: hash.data.native, js: hash.data.js } : {}),
		project: project.project.name,
		...(project.project.variant !== undefined ? { variant: project.project.variant } : {}),
		projectKey: project.projectKey,
	});
	return hash;
}

/**
 * A project resolved for one platform: what every device of a run installs. A kind-less app is its cache key; a
 * `--kind` app is already in the cache (built, or repacked once for the run) at `kindApp.hash`.
 */
export type PreparedApp = { project: ProjectContext } & (
	| { hash: CacheKey; kindApp?: undefined }
	| { kindApp: KindApp; hash?: undefined }
);

/** The warnings already reported by this process, so a two-platform run says each once. */
const warned = new Set<string>();

/** `fingerprint.include` / jsInputs that contradict the requested kind, reported once through the host. */
function warnKind(host: AppHost, project: ProjectContext, kind: BuildKind): void {
	for (const message of kindWarnings(project.project, kind)) {
		if (warned.has(message)) continue;
		warned.add(message);
		host.log?.({ kind: "warn", message, scope: "kind" });
	}
}

/** The one-line account of what a kind resolved to. */
function describeKindApp(app: KindApp): string {
	if (app.kind === "simulator") {
		const { repack } = app;
		const took = repack.bundleMs !== undefined ? ` in ${(repack.bundleMs / 1000).toFixed(1)}s` : "";
		return `simulator repack ${repack.jsKey.slice(0, 12)} ${repack.reused ? "reused" : `built${took}`}`;
	}
	return app.fallbackReason !== undefined
		? `release build (repack fallback: ${app.fallbackReason})`
		: `${app.kind} build`;
}

/** `ios.teamId` of the nearest `warden.config.*`: signs the app for a physical iPhone, after `WARDEN_IOS_TEAM_ID`. */
function configuredTeamId(host: AppHost): string | undefined {
	const found = findWardenConfig(host.cwd, undefined, host.env);
	return found.success ? found.data?.config.ios?.teamId : undefined;
}

/** The input of `prepareKindApp` / `installKindApp` for one platform of a loaded project. */
export function kindAppInput(
	host: AppHost,
	deps: AppDeps,
	owner: Owner,
	platform: Platform,
	project: ProjectContext,
	kind: BuildKind,
	opts: Pick<
		EnsureOptions,
		"eas" | "build" | "buildOutput" | "installMode" | "resetKeychain" | "force" | "onPhase" | "bundleEnv" | "physical"
	>
): KindAppInput {
	return {
		...project,
		kind,
		store: host.store(),
		exec: host.exec,
		env: kind !== "dev" && opts.bundleEnv ? { ...host.env, ...opts.bundleEnv } : host.env,
		now: host.now,
		sleep: deps.sleep,
		log: (line) => log(host, line),
		...(opts.buildOutput ? { buildOutput: opts.buildOutput } : {}),
		...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
		pidAlive: deps.pidAlive,
		owner,
		pid: deps.pid,
		platform,
		eas: opts.eas,
		build: opts.build,
		...(opts.installMode !== undefined ? { installMode: opts.installMode } : {}),
		...(opts.resetKeychain ? { resetKeychain: true } : {}),
		...(opts.physical ? { physical: true } : {}),
		...(opts.physical && platform === "ios" ? { configTeamId: configuredTeamId(host) } : {}),
		...(opts.force ? { force: true } : {}),
		...(deps.easPollMs !== undefined ? { easPollMs: deps.easPollMs } : {}),
		...(deps.lockPollMs !== undefined ? { lockPollMs: deps.lockPollMs } : {}),
		git: host.git,
		repackers: deps.repackers ?? projectRepackers(project.project.root),
	};
}

/**
 * Who a prepare locks builds as when the caller names no owner: the process itself. `prepareApp` runs before any
 * device is leased, so the lease session has no owner to hand it.
 */
function resolveOwnerOf(host: Pick<AppHost, "cwd">): Owner {
	return { kind: "user", pid: process.pid, cwd: host.cwd };
}

/** The kind a physical iPhone gets when none is asked for. */
const PHYSICAL_APP_KIND: BuildKind = "release";

/** Load the project and fingerprint it for `platform` (the slow, device-independent half of an ensure). */
export async function prepareApp(
	host: AppHost,
	opts: EnsureOptions,
	platform: Platform,
	deps: AppDeps = defaultAppDeps
): AsyncResult<PreparedApp, WardenError> {
	if (opts.kind !== undefined && opts.variant !== undefined) {
		return wardenErrors.err("usage", "--kind and --variant can't be combined");
	}
	const phone = opts.physical === true && platform === "ios";
	if (phone && opts.kind === undefined && opts.variant !== undefined) {
		return wardenErrors.err(
			"usage",
			"--variant builds are simulator builds: on a physical iPhone use --kind release (or dev)"
		);
	}
	const project = wardenErrors.coded(await loadProject(host, opts, platform), "config_invalid");
	if (!project.success) return project;
	// a phone runs a build made for it: without a kind, the release build (the project's kind-less build targets simulators)
	const kind = opts.kind ?? (phone ? PHYSICAL_APP_KIND : undefined);
	if (kind !== undefined) return prepareKind(host, deps, platform, project.data, kind, opts);
	const hash = wardenErrors.coded(await fingerprint(host, project.data, platform), "build_failed");
	return hash.success ? resultFactory.ok({ project: project.data, hash: hash.data }) : hash;
}

/** `--kind`: build, find or repack the kind's app into the cache (once per platform for a run), no device yet. */
async function prepareKind(
	host: AppHost,
	deps: AppDeps,
	platform: Platform,
	project: ProjectContext,
	kind: BuildKind,
	opts: EnsureOptions
): AsyncResult<PreparedApp, WardenError> {
	warnKind(host, project, kind);
	const input = kindAppInput(host, deps, resolveOwnerOf(host), platform, project, kind, opts);
	const app = wardenErrors.coded(await prepareKindApp(input), "build_failed");
	if (!app.success) return app;
	log(host, `${platform}: ${describeKindApp(app.data)} [${app.data.hash}]`);
	return resultFactory.ok({ project, kindApp: app.data });
}

/** A kind build as the `EnsureResult` every caller of `ensureApp` reads (a repack counts as built). */
function kindResult(app: KindApp): EnsureResult & { kindApp: KindApp } {
	return {
		appPath: app.artifact,
		hash: app.hash,
		source: app.source === "repack" ? "build" : app.source,
		installed: app.installed,
		kindApp: app,
	};
}

/** Make sure the prepared app is installed on `deviceId` (or just resolved into the cache when it is undefined). */
export async function ensurePreparedApp(
	host: AppHost,
	deps: AppDeps,
	owner: Owner,
	platform: Platform,
	deviceId: string | undefined,
	opts: EnsureOptions,
	prepared: PreparedApp
): AsyncResult<EnsureResult & { kindApp?: KindApp }, WardenError> {
	const { project, hash } = prepared;
	if (prepared.kindApp !== undefined) {
		if (deviceId === undefined) return resultFactory.ok(kindResult(prepared.kindApp));
		const kindInput = kindAppInput(host, deps, owner, platform, project, prepared.kindApp.requested, opts);
		const installed = wardenErrors.coded(
			await installKindApp({ ...kindInput, deviceId }, prepared.kindApp),
			"build_failed"
		);
		return installed.success ? resultFactory.ok(kindResult(installed.data)) : installed;
	}
	if (hash === undefined)
		return wardenErrors.err("build_failed", "prepared app has neither a cache key nor a kind build");
	const input: EnsureInput = {
		...project,
		store: host.store(),
		exec: host.exec,
		env: host.env,
		now: host.now,
		sleep: deps.sleep,
		log: (line) => log(host, line),
		...(opts.buildOutput ? { buildOutput: opts.buildOutput } : {}),
		...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
		pidAlive: deps.pidAlive,
		owner,
		pid: deps.pid,
		platform,
		hash: hash.key,
		...(hash.native !== hash.key ? { native: hash.native } : {}),
		eas: opts.eas,
		build: opts.build,
		...(opts.installMode !== undefined ? { installMode: opts.installMode } : {}),
		...(opts.resetKeychain ? { resetKeychain: true } : {}),
		...(opts.physical ? { physical: true } : {}),
		...(deviceId !== undefined ? { deviceId } : {}),
		...(deps.easPollMs !== undefined ? { easPollMs: deps.easPollMs } : {}),
		...(deps.lockPollMs !== undefined ? { lockPollMs: deps.lockPollMs } : {}),
		git: host.git,
	};
	return wardenErrors.coded(await ensureApp(input), "build_failed");
}

/** The `--json` facts of a kind build: the kind it became, the repack's key and, after a fallback, why. */
export function kindJson(app: KindApp): Record<string, unknown> {
	return {
		kind: app.kind,
		requestedKind: app.requested,
		...(app.kind === "simulator"
			? {
					jsKey: app.repack.jsKey,
					baseHash: app.repack.baseHash,
					reused: app.repack.reused,
					bundleMs: app.repack.bundleMs,
				}
			: {}),
		...(app.kind !== "simulator" && app.fallbackReason !== undefined ? { fallbackReason: app.fallbackReason } : {}),
	};
}

/**
 * Fingerprint the project and make sure the matching app is installed on `deviceId` (or just
 * resolved into the cache when `deviceId` is undefined). Shared by `app ensure` and `run --app`.
 */
export async function ensureAppFor(
	host: AppHost,
	deps: AppDeps,
	owner: Owner,
	platform: Platform,
	deviceId: string | undefined,
	opts: EnsureOptions
): AsyncResult<EnsureResult & { kindApp?: KindApp }, WardenError> {
	const prepared = await prepareApp(host, opts, platform, deps);
	if (!prepared.success) return prepared;
	return ensurePreparedApp(host, deps, owner, platform, deviceId, opts, prepared.data);
}

/** `--udid` / `--lease` / `--no-install`: how a caller names the device an ensure installs on. */
export type DeviceFlags = { udid?: string; lease?: string; noInstall: boolean };

/** Target device: `udid`, `lease`, else the caller's single leased device of `platform`. */
export function pickDevice(
	host: Pick<AppHost, "store">,
	owner: Owner,
	platform: Platform,
	flags: DeviceFlags
): Result<string | undefined, WardenError> {
	if (flags.noInstall) return resultFactory.ok(undefined);
	if (flags.udid !== undefined) return resultFactory.ok(flags.udid);
	const store = host.store();
	if (flags.lease !== undefined) {
		const r = store.getLease(flags.lease)?.resource;
		if (r?.kind !== "device" || r.platform !== platform)
			return wardenErrors.err("lease_not_found", `no ${platform} device lease ${flags.lease}`);
		return resultFactory.ok(r.id);
	}
	const mine = store
		.listLeasesByOwner(owner)
		.flatMap((l) => (l.resource.kind === "device" && l.resource.platform === platform ? [l.resource.id] : []));
	const [only, ...rest] = mine;
	if (only !== undefined && rest.length === 0) return resultFactory.ok(only);
	return mine.length === 0
		? wardenErrors.err(
				"no_device_leased",
				`you hold no ${platform} device lease — pass --udid/--lease, \`warden claim ${platform}\` first, or --no-install`
			)
		: wardenErrors.err(
				"ambiguous_device",
				`you hold several ${platform} devices (${mine.join(", ")}) — pick one with --udid or --lease`
			);
}
