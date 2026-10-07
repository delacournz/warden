import { resolve } from "node:path";
import { type EnsureInput, ensureApp, type ProjectContext, projectContext } from "@delacour/warden-core/builds/ensure";
import { type CacheKey, computeCacheKey } from "@delacour/warden-core/builds/fingerprint";
import type { EnsureResult } from "@delacour/warden-core/builds/resolve";
import { processAlive } from "@delacour/warden-core/liveness";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { parsePlatform, resolveOwner, resolvePlatform } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";

/** Effects `app ensure` needs beyond `CommandContext` — injectable for tests. */
export type AppDeps = {
	/** pid recorded on the build lock */
	pid: number;
	sleep: (ms: number) => Promise<void>;
	pidAlive: (pid: number) => boolean;
	easPollMs?: number;
	lockPollMs?: number;
};

export const defaultAppDeps: AppDeps = { pid: process.pid, sleep: (ms) => Bun.sleep(ms), pidAlive: processAlive };

/** Project + cache options shared by `app ensure` and `run --app`. */
export type EnsureOptions = {
	/** `--project` dir (relative to cwd) */
	project?: string;
	bundleId?: string;
	/** false = `--no-eas` */
	eas: boolean;
	/** false = `--no-build` */
	build: boolean;
	/** `--clean`: uninstall before installing, even at the same hash */
	clean?: boolean;
	/** `--variant`: a `projects[].variants.<name>` build */
	variant?: string;
	/** a missing variant falls back to the project's own build (`warden dev`) */
	variantOptional?: boolean;
};

function log(ctx: CommandContext, line: string): void {
	ctx.err(`[warden] ${line}`);
}

async function loadContext(
	ctx: CommandContext,
	opts: Pick<EnsureOptions, "project" | "bundleId" | "variant" | "variantOptional">,
	platform?: Platform
): AsyncResult<ProjectContext> {
	const start = opts.project ? resolve(ctx.cwd, opts.project) : ctx.cwd;
	const bundleId = opts.bundleId !== undefined && platform !== undefined ? { [platform]: opts.bundleId } : undefined;
	return projectContext({
		exec: ctx.exec,
		env: ctx.env,
		start,
		...(bundleId ? { bundleId } : {}),
		...(opts.variant !== undefined ? { variant: opts.variant } : {}),
		...(opts.variantOptional ? { variantOptional: true } : {}),
	});
}

/** Cache key + log it loudly (a hash that differs from EAS's never finds a build). */
async function fingerprint(ctx: CommandContext, project: ProjectContext, platform: Platform): AsyncResult<CacheKey> {
	const hash = await computeCacheKey(ctx.exec, project.project, platform);
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
): AsyncResult<EnsureResult> {
	const project = await loadContext(ctx, opts, platform);
	if (!project.success) return project;
	const hash = await fingerprint(ctx, project.data, platform);
	if (!hash.success) return hash;
	const input: EnsureInput = {
		...project.data,
		store: ctx.store(),
		exec: ctx.exec,
		env: ctx.env,
		now: ctx.now,
		sleep: deps.sleep,
		log: (line) => log(ctx, line),
		pidAlive: deps.pidAlive,
		owner,
		pid: deps.pid,
		platform,
		hash: hash.data.key,
		...(hash.data.native !== hash.data.key ? { native: hash.data.native } : {}),
		eas: opts.eas,
		build: opts.build,
		...(opts.clean ? { clean: true } : {}),
		...(deviceId !== undefined ? { deviceId } : {}),
		...(deps.easPollMs !== undefined ? { easPollMs: deps.easPollMs } : {}),
		...(deps.lockPollMs !== undefined ? { lockPollMs: deps.lockPollMs } : {}),
	};
	return ensureApp(input);
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

type ProjectOpts = { project?: string; bundleId?: string; variant?: string; json?: true };

type EnsureOpts = ProjectOpts & {
	lease?: string;
	udid?: string;
	install: boolean;
	eas: boolean;
	build: boolean;
	clean?: true;
};

function projectOptions(opts: ProjectOpts): Pick<EnsureOptions, "project" | "bundleId" | "variant"> {
	return {
		...(opts.project !== undefined ? { project: opts.project } : {}),
		...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}),
		...(opts.variant !== undefined ? { variant: opts.variant } : {}),
	};
}

function fail(ctx: CommandContext, sub: string, message: string): number {
	ctx.err(ctx.ui.color.red(`warden app ${sub}: ${message}`));
	return 1;
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
	if (opts.clean && device.data === undefined) return fail(ctx, "ensure", "--clean needs a device (drop --no-install)");
	const res = await withSpinner(ctx, `ensuring the ${platform.data} app…`, async (sctx, spinner) => {
		const result = await ensureAppFor(sctx, deps, owner, platform.data, device.data, {
			...projectOptions(opts),
			eas: opts.eas,
			build: opts.build,
			...(opts.clean ? { clean: true } : {}),
		});
		if (result.success) spinner.succeed(`${platform.data} app ready (${result.data.source})`);
		else spinner.fail(`${platform.data} app not ready`);
		return result;
	});
	if (!res.success) return fail(ctx, "ensure", res.error);
	const r = res.data;
	const where = device.data ? ` → ${r.installed ? "installed on" : "not installed on"} ${device.data}` : "";
	emit(
		ctx,
		opts.json === true,
		r,
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
				.option("--clean", "uninstall the app first, so the run starts from a fresh container")
				.option("--bundle-id <id>", "override the bundle id / package")
				.option("--variant <name>", "use this projects[].variants build (dev, e2e…)")
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
