import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type EnsureInput, ensureApp, type ProjectContext, projectContext } from "@warden/core/builds/ensure";
import { computeFingerprint } from "@warden/core/builds/fingerprint";
import type { EnsureResult } from "@warden/core/builds/resolve";
import { processAlive } from "@warden/core/liveness";
import type { Owner, Platform } from "@warden/core/types";
import { type AsyncResult, err, ok, type Result } from "@warden/types/result";
import { parsePlatform, resolveOwner } from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { emit } from "../output";

const USAGE = [
	"warden app ensure ios|android [--project dir] [--lease id | --udid X | --no-install] [--no-eas] [--no-build] [--bundle-id X] [--json]",
	"warden app fingerprint [ios|android] [--project dir] [--bundle-id X] [--json]",
].join("\n");

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
};

function log(ctx: CommandContext, line: string): void {
	ctx.err(`[warden] ${line}`);
}

async function loadContext(
	ctx: CommandContext,
	opts: Pick<EnsureOptions, "project" | "bundleId">,
	platform?: Platform
): AsyncResult<ProjectContext> {
	const start = opts.project ? resolve(ctx.cwd, opts.project) : ctx.cwd;
	const bundleId = opts.bundleId !== undefined && platform !== undefined ? { [platform]: opts.bundleId } : undefined;
	return projectContext({ exec: ctx.exec, env: ctx.env, start, ...(bundleId ? { bundleId } : {}) });
}

/** Fingerprint + log it loudly (a hash that differs from EAS's never finds a build). */
async function fingerprint(ctx: CommandContext, project: ProjectContext, platform: Platform): AsyncResult<string> {
	const hash = await computeFingerprint(ctx.exec, project.project, platform);
	if (!hash.success) return hash;
	log(ctx, "────────────────────────────────────────────────────────");
	log(ctx, `${platform} fingerprint: ${hash.data}`);
	log(ctx, `project ${project.project.name} (${project.projectKey})`);
	log(ctx, "────────────────────────────────────────────────────────");
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
		hash: hash.data,
		eas: opts.eas,
		build: opts.build,
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

const ENSURE_OPTIONS = {
	project: { type: "string" },
	"bundle-id": { type: "string" },
	lease: { type: "string" },
	udid: { type: "string" },
	"no-install": { type: "boolean" },
	"no-eas": { type: "boolean" },
	"no-build": { type: "boolean" },
	json: { type: "boolean" },
} as const;

function parseEnsure(argv: string[]) {
	return parseArgs({ args: argv, options: ENSURE_OPTIONS, allowPositionals: true, strict: true });
}

function parseFingerprint(argv: string[]) {
	return parseArgs({
		args: argv,
		options: { project: { type: "string" }, "bundle-id": { type: "string" }, json: { type: "boolean" } },
		allowPositionals: true,
		strict: true,
	});
}

async function ensureCmd(ctx: CommandContext, deps: AppDeps, argv: string[]): Promise<number> {
	const { values, positionals } = parseEnsure(argv);
	const platform = parsePlatform(positionals[0]);
	if (!platform.success) {
		ctx.err(`warden app ensure: ${platform.error}\n${USAGE}`);
		return 1;
	}
	const owner = resolveOwner(ctx);
	const device = pickDevice(ctx, owner, platform.data, {
		...(values.udid !== undefined ? { udid: values.udid } : {}),
		...(values.lease !== undefined ? { lease: values.lease } : {}),
		noInstall: values["no-install"] === true,
	});
	if (!device.success) {
		ctx.err(`warden app ensure: ${device.error}`);
		return 1;
	}
	const res = await ensureAppFor(ctx, deps, owner, platform.data, device.data, {
		...(values.project !== undefined ? { project: values.project } : {}),
		...(values["bundle-id"] !== undefined ? { bundleId: values["bundle-id"] } : {}),
		eas: values["no-eas"] !== true,
		build: values["no-build"] !== true,
	});
	if (!res.success) {
		ctx.err(`warden app ensure: ${res.error}`);
		return 1;
	}
	const r = res.data;
	const where = device.data ? ` → ${r.installed ? "installed on" : "not installed on"} ${device.data}` : "";
	emit(ctx, values.json === true, r, `${r.source}: ${r.appPath || "(already installed)"} [${r.hash}]${where}`);
	return 0;
}

async function fingerprintCmd(ctx: CommandContext, argv: string[]): Promise<number> {
	const { values, positionals } = parseFingerprint(argv);
	const platforms: Platform[] = [];
	if (positionals[0] === undefined) platforms.push("ios", "android");
	else {
		const p = parsePlatform(positionals[0]);
		if (!p.success) {
			ctx.err(`warden app fingerprint: ${p.error}\n${USAGE}`);
			return 1;
		}
		platforms.push(p.data);
	}
	const project = await loadContext(
		ctx,
		{
			...(values.project !== undefined ? { project: values.project } : {}),
			...(values["bundle-id"] !== undefined ? { bundleId: values["bundle-id"] } : {}),
		},
		platforms.length === 1 ? platforms[0] : undefined
	);
	if (!project.success) {
		ctx.err(`warden app fingerprint: ${project.error}`);
		return 1;
	}
	const fingerprints: Partial<Record<Platform, string>> = {};
	for (const platform of platforms) {
		const hash = await fingerprint(ctx, project.data, platform);
		if (!hash.success) {
			ctx.err(`warden app fingerprint: ${hash.error}`);
			return 1;
		}
		fingerprints[platform] = hash.data;
	}
	const text = platforms.map((p) => `${p.padEnd(7)}  ${fingerprints[p]}`).join("\n");
	emit(
		ctx,
		values.json === true,
		{
			project: project.data.project.name,
			projectKey: project.data.projectKey,
			root: project.data.project.root,
			fingerprints,
		},
		text
	);
	return 0;
}

export function createAppCommand(deps: AppDeps): Command {
	async function run(ctx: CommandContext): Promise<number> {
		const [sub, ...rest] = ctx.argv;
		try {
			if (sub === "ensure") return await ensureCmd(ctx, deps, rest);
			if (sub === "fingerprint") return await fingerprintCmd(ctx, rest);
		} catch (error) {
			ctx.err(`warden app: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
			return 1;
		}
		ctx.err(`warden app: unknown subcommand "${sub ?? ""}"\n${USAGE}`);
		return 1;
	}
	return {
		name: "app",
		summary: "fingerprint an Expo app and install the matching build (installed → cache → EAS → local build)",
		usage: USAGE,
		run,
	};
}

export const appCommand: Command = createAppCommand(defaultAppDeps);
