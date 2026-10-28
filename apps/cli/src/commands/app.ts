import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { InstallMode } from "@delacour/warden-core/builds/app-option.schema";
import { type EnsureInput, ensureApp, type ProjectContext } from "@delacour/warden-core/builds/ensure";
import {
	installKindApp,
	type KindApp,
	type KindAppInput,
	kindWarnings,
	prepareKindApp,
	projectRepackers,
} from "@delacour/warden-core/builds/ensure-kind";
import { type CacheKey, computeCacheKey } from "@delacour/warden-core/builds/fingerprint";
import { BUILD_KINDS, type BuildKind } from "@delacour/warden-core/builds/kinds";
import type { ApplyRepack } from "@delacour/warden-core/builds/repack.types";
import type { AppPhase, EnsureResult } from "@delacour/warden-core/builds/resolve";
import { processAlive } from "@delacour/warden-core/liveness";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { parsePlatform, resolveOwner, resolvePlatform } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { installModeOption, kindOption, legacyCleanOption, parseInstallFlags } from "../install-flags";
import { emit, heading, reportError } from "../output";
import { projectContextFor } from "../project-context";
import { withSpinner } from "../spinner-context";

/** Effects `app ensure` needs beyond `CommandContext` — injectable for tests. */
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
export function parseKind(value: string): Result<BuildKind> {
	const kind = BUILD_KINDS.find((k) => k === value);
	return kind ? ok(kind) : err(`--kind ${value}: expected ${BUILD_KINDS.join(" | ")}`);
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
	/** progress for a spinner: what the resolve is doing (`AppPhase`) */
	onPhase?: (phase: AppPhase) => void;
	/** a local build's own output, line by line, while it runs (`warden dev`'s dashboard); unset = only the failure summary */
	buildOutput?: (line: string) => void;
};

function log(ctx: CommandContext, line: string): void {
	ctx.err(`[warden] ${line}`);
}

/** Where project discovery starts: `--project` (relative to cwd, must be a directory) or cwd. */
export function projectStart(ctx: CommandContext, project: string | undefined): Result<string> {
	if (!project) return ok(ctx.cwd);
	const start = resolve(ctx.cwd, project);
	return statSync(start, { throwIfNoEntry: false })?.isDirectory()
		? ok(start)
		: err(`--project ${project}: no such directory ${start} (cwd ${ctx.cwd})`);
}

async function loadContext(
	ctx: CommandContext,
	opts: Pick<EnsureOptions, "project" | "bundleId" | "variant" | "variantOptional">,
	platform?: Platform
): AsyncResult<ProjectContext> {
	const start = projectStart(ctx, opts.project);
	if (!start.success) return start;
	const bundleId = opts.bundleId !== undefined && platform !== undefined ? { [platform]: opts.bundleId } : undefined;
	return projectContextFor(ctx, {
		start: start.data,
		...(bundleId ? { bundleId } : {}),
		...(opts.variant !== undefined ? { variant: opts.variant } : {}),
		...(opts.variantOptional ? { variantOptional: true } : {}),
	});
}

/** Cache key + log it loudly (a hash that differs from EAS's never finds a build). */
async function fingerprint(ctx: CommandContext, project: ProjectContext, platform: Platform): AsyncResult<CacheKey> {
	const hash = await computeCacheKey(
		ctx.exec,
		project.project,
		platform,
		undefined,
		{ store: ctx.store(), now: ctx.now() },
		ctx.env
	);
	if (!hash.success) return hash;
	const { color } = ctx.ui;
	const rule = color.dim("────────────────────────────────────────────────────────");
	log(ctx, rule);
	log(ctx, `${platform} fingerprint: ${color.bold(hash.data.key)}`);
	if (hash.data.js !== undefined) {
		log(ctx, color.dim(`  native ${hash.data.native} + js ${hash.data.js} (fingerprint.include native+js)`));
	}
	const variant = project.project.variant === undefined ? "" : ` variant ${project.project.variant}`;
	log(ctx, `project ${project.project.name}${variant} (${project.projectKey})`);
	log(ctx, rule);
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

/** The warnings already printed by this process, so a two-platform run says each once. */
const warned = new Set<string>();

/** `fingerprint.include` / jsInputs that contradict the requested kind, on stderr once. */
function warnKind(ctx: CommandContext, project: ProjectContext, kind: BuildKind): void {
	for (const message of kindWarnings(project.project, kind)) {
		if (warned.has(message)) continue;
		warned.add(message);
		ctx.err(ctx.ui.color.yellow(`[warden] warning: ${message}`));
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

/** The input of `prepareKindApp` / `installKindApp` for one platform of a loaded project. */
export function kindAppInput(
	ctx: CommandContext,
	deps: AppDeps,
	owner: Owner,
	platform: Platform,
	project: ProjectContext,
	kind: BuildKind,
	opts: Pick<
		EnsureOptions,
		"eas" | "build" | "buildOutput" | "installMode" | "resetKeychain" | "force" | "onPhase" | "bundleEnv"
	>
): KindAppInput {
	return {
		...project,
		kind,
		store: ctx.store(),
		exec: ctx.exec,
		env: kind !== "dev" && opts.bundleEnv ? { ...ctx.env, ...opts.bundleEnv } : ctx.env,
		now: ctx.now,
		sleep: deps.sleep,
		log: (line) => log(ctx, line),
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
		...(opts.force ? { force: true } : {}),
		...(deps.easPollMs !== undefined ? { easPollMs: deps.easPollMs } : {}),
		...(deps.lockPollMs !== undefined ? { lockPollMs: deps.lockPollMs } : {}),
		git: ctx.git,
		repackers: deps.repackers ?? projectRepackers(project.project.root),
	};
}

/** Load the project and fingerprint it for `platform` (the slow, device-independent half of an ensure). */
export async function prepareApp(
	ctx: CommandContext,
	opts: EnsureOptions,
	platform: Platform,
	deps: AppDeps = defaultAppDeps
): AsyncResult<PreparedApp> {
	if (opts.kind !== undefined && opts.variant !== undefined) return err("--kind and --variant can't be combined");
	const project = await loadContext(ctx, opts, platform);
	if (!project.success) return project;
	if (opts.kind !== undefined) return prepareKind(ctx, deps, platform, project.data, opts.kind, opts);
	const hash = await fingerprint(ctx, project.data, platform);
	return hash.success ? ok({ project: project.data, hash: hash.data }) : hash;
}

/** `--kind`: build, find or repack the kind's app into the cache (once per platform for a run), no device yet. */
async function prepareKind(
	ctx: CommandContext,
	deps: AppDeps,
	platform: Platform,
	project: ProjectContext,
	kind: BuildKind,
	opts: EnsureOptions
): AsyncResult<PreparedApp> {
	warnKind(ctx, project, kind);
	const input = kindAppInput(ctx, deps, resolveOwner(ctx), platform, project, kind, opts);
	const app = await prepareKindApp(input);
	if (!app.success) return app;
	log(ctx, `${platform}: ${describeKindApp(app.data)} [${app.data.hash}]`);
	return ok({ project, kindApp: app.data });
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
	ctx: CommandContext,
	deps: AppDeps,
	owner: Owner,
	platform: Platform,
	deviceId: string | undefined,
	opts: EnsureOptions,
	prepared: PreparedApp
): AsyncResult<EnsureResult & { kindApp?: KindApp }> {
	const { project, hash } = prepared;
	if (prepared.kindApp !== undefined) {
		if (deviceId === undefined) return ok(kindResult(prepared.kindApp));
		const kindInput = kindAppInput(ctx, deps, owner, platform, project, prepared.kindApp.requested, opts);
		const installed = await installKindApp({ ...kindInput, deviceId }, prepared.kindApp);
		return installed.success ? ok(kindResult(installed.data)) : installed;
	}
	if (hash === undefined) return err("prepared app has neither a cache key nor a kind build");
	const input: EnsureInput = {
		...project,
		store: ctx.store(),
		exec: ctx.exec,
		env: ctx.env,
		now: ctx.now,
		sleep: deps.sleep,
		log: (line) => log(ctx, line),
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
		...(deviceId !== undefined ? { deviceId } : {}),
		...(deps.easPollMs !== undefined ? { easPollMs: deps.easPollMs } : {}),
		...(deps.lockPollMs !== undefined ? { lockPollMs: deps.lockPollMs } : {}),
		git: ctx.git,
	};
	return ensureApp(input);
}

/**
 * Fingerprint the project and make sure the matching app is installed on `deviceId` (or just
 * resolved into the cache when `deviceId` is undefined). Shared by `app ensure` and `run --app`.
 */
export async function ensureAppFor(
	ctx: CommandContext,
	deps: AppDeps,
	owner: Owner,
	platform: Platform,
	deviceId: string | undefined,
	opts: EnsureOptions
): AsyncResult<EnsureResult & { kindApp?: KindApp }> {
	const prepared = await prepareApp(ctx, opts, platform, deps);
	if (!prepared.success) return prepared;
	return ensurePreparedApp(ctx, deps, owner, platform, deviceId, opts, prepared.data);
}

type DeviceFlags = { udid?: string; lease?: string; noInstall: boolean };

/** Target device: `--udid`, `--lease`, else the caller's single leased device of `platform`. */
export function pickDevice(
	ctx: CommandContext,
	owner: Owner,
	platform: Platform,
	flags: DeviceFlags
): Result<string | undefined> {
	if (flags.noInstall) return ok(undefined);
	if (flags.udid !== undefined) return ok(flags.udid);
	const store = ctx.store();
	if (flags.lease !== undefined) {
		const r = store.getLease(flags.lease)?.resource;
		if (r?.kind !== "device" || r.platform !== platform) return err(`no ${platform} device lease ${flags.lease}`);
		return ok(r.id);
	}
	const mine = store
		.listLeasesByOwner(owner)
		.flatMap((l) => (l.resource.kind === "device" && l.resource.platform === platform ? [l.resource.id] : []));
	const [only, ...rest] = mine;
	if (only !== undefined && rest.length === 0) return ok(only);
	return err(
		mine.length === 0
			? `you hold no ${platform} device lease — pass --udid/--lease, \`warden claim ${platform}\` first, or --no-install`
			: `you hold several ${platform} devices (${mine.join(", ")}) — pick one with --udid or --lease`
	);
}

type ProjectOpts = { project?: string; bundleId?: string; variant?: string; kind?: string; json?: true };

type EnsureOpts = ProjectOpts & {
	lease?: string;
	udid?: string;
	install: boolean;
	eas: boolean;
	build: boolean;
	installMode?: InstallMode;
	resetKeychain?: true;
	clean?: true;
};

function projectOptions(opts: ProjectOpts): Pick<EnsureOptions, "project" | "bundleId" | "variant"> {
	return {
		...(opts.project !== undefined ? { project: opts.project } : {}),
		...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}),
		...(opts.variant !== undefined ? { variant: opts.variant } : {}),
	};
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

function fail(ctx: CommandContext, sub: string, message: string): number {
	reportError(ctx, `app ${sub}`, message);
	return 1;
}

/** `app ensure`'s install flags and `--kind`, checked against the device the command targets. */
function ensureFlags(
	opts: EnsureOpts,
	device: string | undefined
): Result<{ install: { installMode?: InstallMode; resetKeychain?: true }; kind?: BuildKind }> {
	const install = parseInstallFlags(opts);
	if (!install.success) return install;
	const kind = opts.kind === undefined ? undefined : parseKind(opts.kind);
	if (kind && !kind.success) return kind;
	if (install.data.installMode !== undefined && device === undefined) {
		return err("--install-mode needs a device (drop --no-install)");
	}
	return ok({ install: install.data, ...(kind ? { kind: kind.data } : {}) });
}

/** Fingerprint → installed / cache / EAS / local build, under a spinner (can take minutes). */
async function ensureCmd(
	ctx: CommandContext,
	deps: AppDeps,
	platformArg: string | undefined,
	opts: EnsureOpts
): Promise<number> {
	const { color } = ctx.ui;
	const platform = await resolvePlatform(ctx, platformArg);
	if (!platform.success) return fail(ctx, "ensure", platform.error);
	const owner = resolveOwner(ctx);
	const device = pickDevice(ctx, owner, platform.data, {
		...(opts.udid !== undefined ? { udid: opts.udid } : {}),
		...(opts.lease !== undefined ? { lease: opts.lease } : {}),
		noInstall: !opts.install,
	});
	if (!device.success) return fail(ctx, "ensure", device.error);
	const flags = ensureFlags(opts, device.data);
	if (!flags.success) return fail(ctx, "ensure", flags.error);
	const { install, kind } = flags.data;
	if (!opts.json) heading(ctx, "app ensure", `${platform.data}${device.data ? ` · ${device.data}` : ""}`);
	const res = await withSpinner(ctx, `ensuring the ${platform.data} app…`, async (sctx, spinner) => {
		const result = await ensureAppFor(sctx, deps, owner, platform.data, device.data, {
			...projectOptions(opts),
			...(kind !== undefined ? { kind } : {}),
			eas: opts.eas,
			build: opts.build,
			...install,
		});
		if (result.success) spinner.succeed(`${platform.data} app ready (${result.data.source})`);
		else spinner.fail(`${platform.data} app not ready`);
		return result;
	});
	if (!res.success) return fail(ctx, "ensure", res.error);
	const { kindApp, ...r } = res.data;
	const where = device.data ? ` → ${r.installed ? "installed on" : "not installed on"} ${device.data}` : "";
	emit(
		ctx,
		opts.json === true,
		kindApp === undefined ? r : { ...r, ...kindJson(kindApp) },
		`${color.green(r.source)}: ${r.appPath || "(already installed)"} ${color.dim(`[${r.hash}]`)}${where}`
	);
	return 0;
}

async function fingerprintCmd(
	ctx: CommandContext,
	platformArg: string | undefined,
	opts: ProjectOpts
): Promise<number> {
	const platforms: Platform[] = [];
	if (platformArg === undefined) platforms.push("ios", "android");
	else {
		const p = parsePlatform(platformArg);
		if (!p.success) return fail(ctx, "fingerprint", p.error);
		platforms.push(p.data);
	}
	const project = await loadContext(ctx, projectOptions(opts), platforms.length === 1 ? platforms[0] : undefined);
	if (!project.success) return fail(ctx, "fingerprint", project.error);
	const fingerprints: Partial<Record<Platform, string>> = {};
	const native: Partial<Record<Platform, string>> = {};
	const failed = await withSpinner(ctx, `fingerprinting ${platforms.join(" + ")}…`, async (sctx) => {
		for (const platform of platforms) {
			const hash = await fingerprint(sctx, project.data, platform);
			if (!hash.success) return hash.error;
			fingerprints[platform] = hash.data.key;
			if (hash.data.js !== undefined) native[platform] = hash.data.native;
		}
		return undefined;
	});
	if (failed !== undefined) return fail(ctx, "fingerprint", failed);
	const text = platforms.map((p) => `${p.padEnd(7)}  ${ctx.ui.color.bold(fingerprints[p] ?? "")}`).join("\n");
	emit(
		ctx,
		opts.json === true,
		{
			project: project.data.project.name,
			projectKey: project.data.projectKey,
			root: project.data.project.root,
			...(project.data.project.variant !== undefined ? { variant: project.data.project.variant } : {}),
			fingerprints,
			...(Object.keys(native).length > 0 ? { native } : {}),
		},
		text
	);
	return 0;
}

export function createAppCommand(deps: AppDeps): Command {
	return defineCommand({
		name: "app",
		group: "Builds",
		summary: "fingerprint an Expo app and install the matching build (installed → cache → EAS → local build)",
		register: (cmd, ctx, done) => {
			cmd
				.command("ensure")
				.description(
					"install the build matching the project's fingerprint on a device (installed → cache → EAS → build)"
				)
				.argument("[platform]", "ios | android (asked for when omitted in a terminal)")
				.option("--project <dir>", "project directory (default: cwd)")
				.option("--lease <id>", "device of this lease")
				.option("--udid <udid>", "this device")
				.option("--no-install", "only resolve the build into the cache")
				.option("--no-eas", "don't download EAS builds")
				.option("--no-build", "don't build locally on a cache miss")
				.addOption(installModeOption())
				.option("--reset-keychain", "--install-mode: also reset the iOS simulator's keychain")
				.addOption(legacyCleanOption())
				.option("--bundle-id <id>", "override the bundle id / package")
				.option("--variant <name>", "use this projects[].variants build (dev, e2e…)")
				.addOption(kindOption())
				.option("--json", "machine-readable output")
				.action(async (platform, opts) => done(await ensureCmd(ctx, deps, platform, opts)));
			cmd
				.command("fingerprint")
				.description("print the project's native fingerprint (both platforms by default)")
				.argument("[platform]", "ios | android")
				.option("--project <dir>", "project directory (default: cwd)")
				.option("--bundle-id <id>", "override the bundle id / package")
				.option("--variant <name>", "fingerprint this projects[].variants build")
				.option("--json", "machine-readable output")
				.action(async (platform, opts) => done(await fingerprintCmd(ctx, platform, opts)));
		},
	});
}

export const appCommand: Command = createAppCommand(defaultAppDeps);
