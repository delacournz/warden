import type { KindApp } from "@delacour/warden-builds/ensure-kind";
import {
	type AppDeps,
	defaultAppDeps,
	type EnsureOptions,
	ensureAppFor,
	fingerprint,
	loadProject,
	parseKind,
	pickDevice,
} from "@delacour/warden-builds/prepare";
import type { InstallMode } from "@delacour/warden-config/app-option.schema";
import type { BuildKind } from "@delacour/warden-config/build-kinds";
import { resolveOwner } from "@delacour/warden-leasing/owner";
import type { AppEnsureJson } from "@delacour/warden-sdk/contracts/dev";
import { isPhysicalIosId, type Platform } from "@delacour/warden-store/types";
import { wardenErrors } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { parsePlatform, resolvePlatform } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import { appHostFromContext, type CommandContext } from "../context";
import { installModeOption, kindOption, legacyCleanOption, parseInstallFlags } from "../install-flags";
import { emit, heading, reportError } from "../output";
import { withSpinner } from "../spinner-context";

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
	if (kind && !kind.success) return wardenErrors.toText(kind);
	if (install.data.installMode !== undefined && device === undefined) {
		return resultFactory.err("--install-mode needs a device (drop --no-install)");
	}
	return resultFactory.ok({ install: install.data, ...(kind ? { kind: kind.data } : {}) });
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
	if (!device.success) return fail(ctx, "ensure", device.error.message);
	const flags = ensureFlags(opts, device.data);
	if (!flags.success) return fail(ctx, "ensure", flags.error);
	const phone = platform.data === "ios" && device.data !== undefined && isPhysicalIosId(device.data);
	const { install, kind } = flags.data;
	if (!opts.json) heading(ctx, "app ensure", `${platform.data}${device.data ? ` · ${device.data}` : ""}`);
	const res = await withSpinner(ctx, `ensuring the ${platform.data} app…`, async (sctx, spinner) => {
		const result = await ensureAppFor(appHostFromContext(sctx), deps, owner, platform.data, device.data, {
			...projectOptions(opts),
			...(kind !== undefined ? { kind } : {}),
			...(phone ? { physical: true } : {}),
			eas: opts.eas,
			build: opts.build,
			...install,
		});
		if (result.success) spinner.succeed(`${platform.data} app ready (${result.data.source})`);
		else spinner.fail(`${platform.data} app not ready`);
		return result;
	});
	if (!res.success) return fail(ctx, "ensure", res.error.message);
	const { kindApp, ...r } = res.data;
	const where = device.data ? ` → ${r.installed ? "installed on" : "not installed on"} ${device.data}` : "";
	const ensured: AppEnsureJson = r;
	emit(
		ctx,
		opts.json === true,
		kindApp === undefined ? ensured : { ...ensured, ...kindJson(kindApp) },
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
	const project = await loadProject(
		appHostFromContext(ctx),
		projectOptions(opts),
		platforms.length === 1 ? platforms[0] : undefined
	);
	if (!project.success) return fail(ctx, "fingerprint", project.error);
	const fingerprints: Partial<Record<Platform, string>> = {};
	const native: Partial<Record<Platform, string>> = {};
	const failed = await withSpinner(ctx, `fingerprinting ${platforms.join(" + ")}…`, async (sctx) => {
		for (const platform of platforms) {
			const hash = await fingerprint(appHostFromContext(sctx), project.data, platform);
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
