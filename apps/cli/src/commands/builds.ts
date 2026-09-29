import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_MAX_CACHE_SIZE } from "@warden/core/builds/builds.defaults";
import { listBuilds, storeArtifact } from "@warden/core/builds/cache";
import { LOCAL_PROFILE, projectContext } from "@warden/core/builds/ensure";
import { formatSize, parseSize, pruneBuilds } from "@warden/core/builds/prune";
import { formatDuration } from "@warden/core/duration";
import { processAlive } from "@warden/core/liveness";
import type { Platform } from "@warden/core/types";
import { err, ok, type Result } from "@warden/types/result";
import { parsePlatform } from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { emit, formatTable } from "../output";

const USAGE = [
	"warden builds ls [--json]",
	"warden builds prune [--max-size 20G] [--dry-run] [--json]",
	"warden builds import <path.app|path.apk> --hash H [--platform ios|android] [--project dir] [--profile p] [--bundle-id X] [--json]",
].join("\n");

function lsCmd(ctx: CommandContext, argv: string[]): number {
	const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" } }, strict: true });
	const builds = listBuilds(ctx.store());
	const now = ctx.now();
	const rows = builds.map((b) => [
		b.projectKey,
		b.platform,
		b.hash.slice(0, 12),
		b.source,
		b.profile,
		formatSize(b.size),
		`${formatDuration(Math.max(0, now - b.lastUsedAt))} ago`,
		b.path,
	]);
	const total = builds.reduce((s, b) => s + b.size, 0);
	const text =
		builds.length === 0
			? "no cached builds"
			: `${formatTable(["PROJECT", "PLATFORM", "HASH", "SOURCE", "PROFILE", "SIZE", "LAST USED", "PATH"], rows)}\n\ntotal ${formatSize(total)}`;
	emit(ctx, values.json === true, { builds, totalBytes: total }, text);
	return 0;
}

function pruneCmd(ctx: CommandContext, argv: string[]): number {
	const { values } = parseArgs({
		args: argv,
		options: { "max-size": { type: "string" }, "dry-run": { type: "boolean" }, json: { type: "boolean" } },
		strict: true,
	});
	const max = parseSize(values["max-size"] ?? DEFAULT_MAX_CACHE_SIZE);
	if (!max.success) {
		ctx.err(`warden builds prune: ${max.error}`);
		return 1;
	}
	const dryRun = values["dry-run"] === true;
	const plan = pruneBuilds({
		store: ctx.store(),
		env: ctx.env,
		maxBytes: max.data,
		now: ctx.now(),
		pidAlive: processAlive,
		dryRun,
	});
	const verb = dryRun ? "would remove" : "removed";
	const text = [
		...plan.remove.map((b) => `${verb} ${b.projectKey} ${b.platform} ${b.hash} (${formatSize(b.size)})`),
		`${formatSize(plan.total)} → ${formatSize(plan.after)} (max ${formatSize(max.data)})`,
	].join("\n");
	emit(
		ctx,
		values.json === true,
		{ dryRun, removed: plan.remove, totalBytes: plan.total, afterBytes: plan.after, maxBytes: max.data },
		text
	);
	return 0;
}

/** `.app` → ios, `.apk` → android, unless `--platform` says otherwise. */
export function inferPlatform(path: string, flag: string | undefined): Result<Platform> {
	if (flag !== undefined) return parsePlatform(flag);
	const clean = path.replace(/\/+$/, "");
	if (clean.endsWith(".app")) return ok("ios");
	if (clean.endsWith(".apk")) return ok("android");
	return err(`can't tell the platform of ${path} — pass --platform ios|android`);
}

async function importCmd(ctx: CommandContext, argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			hash: { type: "string" },
			platform: { type: "string" },
			project: { type: "string" },
			profile: { type: "string" },
			"bundle-id": { type: "string" },
			json: { type: "boolean" },
		},
		allowPositionals: true,
		strict: true,
	});
	const [raw] = positionals;
	if (raw === undefined || values.hash === undefined) {
		ctx.err(`warden builds import: need <path> and --hash\n${USAGE}`);
		return 1;
	}
	const artifact = resolve(ctx.cwd, raw).replace(/\/+$/, "");
	const platform = inferPlatform(artifact, values.platform);
	if (!platform.success) {
		ctx.err(`warden builds import: ${platform.error}`);
		return 1;
	}
	const start = values.project ? resolve(ctx.cwd, values.project) : ctx.cwd;
	const bundle = values["bundle-id"];
	const project = await projectContext({
		exec: ctx.exec,
		env: ctx.env,
		start,
		...(bundle !== undefined ? { bundleId: { [platform.data]: bundle } } : {}),
	});
	if (!project.success) {
		ctx.err(`warden builds import: ${project.error}`);
		return 1;
	}
	const stored = await storeArtifact({
		store: ctx.store(),
		env: ctx.env,
		projectKey: project.data.projectKey,
		platform: platform.data,
		profile: values.profile ?? project.data.project.eas?.profile ?? LOCAL_PROFILE,
		hash: values.hash,
		artifact,
		source: "import",
		now: ctx.now(),
	});
	if (!stored.success) {
		ctx.err(`warden builds import: ${stored.error}`);
		return 1;
	}
	const b = stored.data;
	emit(ctx, values.json === true, b, `imported ${b.platform} ${b.hash} → ${b.path} (${formatSize(b.size)})`);
	return 0;
}

async function run(ctx: CommandContext): Promise<number> {
	const [sub, ...rest] = ctx.argv;
	try {
		if (sub === "ls" || sub === undefined) return lsCmd(ctx, rest);
		if (sub === "prune") return pruneCmd(ctx, rest);
		if (sub === "import") return await importCmd(ctx, rest);
	} catch (error) {
		ctx.err(`warden builds: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 1;
	}
	ctx.err(`warden builds: unknown subcommand "${sub}"\n${USAGE}`);
	return 1;
}

export const buildsCommand: Command = {
	name: "builds",
	summary: "list, prune (LRU) and import cached native app builds",
	usage: USAGE,
	run,
};
