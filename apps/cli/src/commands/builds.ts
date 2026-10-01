import { resolve } from "node:path";
import { DEFAULT_MAX_CACHE_SIZE } from "@delacour/warden-core/builds/builds.defaults";
import { listBuilds, storeArtifact } from "@delacour/warden-core/builds/cache";
import { LOCAL_PROFILE, projectContext } from "@delacour/warden-core/builds/ensure";
import { formatSize, parseSize, pruneBuilds } from "@delacour/warden-core/builds/prune";
import { formatDuration } from "@delacour/warden-core/duration";
import { processAlive } from "@delacour/warden-core/liveness";
import type { Platform } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { parsePlatform } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, formatTable } from "../output";
import { withSpinner } from "../spinner-context";

function fail(ctx: CommandContext, sub: string, message: string): number {
	ctx.err(ctx.ui.color.red(`warden builds ${sub}: ${message}`));
	return 1;
}

function lsCmd(ctx: CommandContext, json: boolean): number {
	const { color } = ctx.ui;
	const builds = listBuilds(ctx.store());
	const now = ctx.now();
	const rows = builds.map((b) => [
		b.projectKey,
		b.platform,
		color.bold(b.hash.slice(0, 12)),
		b.source,
		b.profile,
		formatSize(b.size),
		`${formatDuration(Math.max(0, now - b.lastUsedAt))} ago`,
		color.dim(b.path),
	]);
	const total = builds.reduce((s, b) => s + b.size, 0);
	const text =
		builds.length === 0
			? color.dim("no cached builds")
			: `${formatTable(["PROJECT", "PLATFORM", "HASH", "SOURCE", "PROFILE", "SIZE", "LAST USED", "PATH"], rows, color)}\n\ntotal ${color.bold(formatSize(total))}`;
	emit(ctx, json, { builds, totalBytes: total }, text);
	return 0;
}

type PruneOpts = { maxSize?: string; dryRun?: true; yes?: true; json?: true };

const describeBuild = (b: { projectKey: string; platform: string; hash: string; size: number }) =>
	`${b.projectKey} ${b.platform} ${b.hash} (${formatSize(b.size)})`;

/**
 * LRU-prune the cache down to `--max-size`. In a terminal (without `--yes` / `--dry-run`) shows
 * what goes and asks first.
 */
async function pruneCmd(ctx: CommandContext, opts: PruneOpts): Promise<number> {
	const { ui } = ctx;
	const { color } = ui;
	const max = parseSize(opts.maxSize ?? DEFAULT_MAX_CACHE_SIZE);
	if (!max.success) return fail(ctx, "prune", max.error);
	const dryRun = opts.dryRun === true;
	const prune = (dry: boolean) =>
		pruneBuilds({
			store: ctx.store(),
			env: ctx.env,
			maxBytes: max.data,
			now: ctx.now(),
			pidAlive: processAlive,
			dryRun: dry,
		});
	const preview = prune(true);
	if (!dryRun && ui.interactive && !opts.yes) {
		if (preview.remove.length > 0) {
			for (const b of preview.remove) ctx.err(color.yellow(`will remove ${describeBuild(b)}`));
			const freed = preview.remove.reduce((sum, b) => sum + b.size, 0);
			const answer = await ui.confirm(`Remove ${preview.remove.length} cached build(s) (${formatSize(freed)})?`);
			if (answer !== true) {
				ui.cancelled("Aborted.");
				return 1;
			}
		}
	}
	const plan = dryRun
		? preview
		: await withSpinner(ctx, `pruning ${preview.remove.length} build(s)…`, async () => prune(false));
	const verb = dryRun ? "would remove" : "removed";
	const text = [
		...plan.remove.map((b) => (dryRun ? color.yellow : color.green)(`${verb} ${describeBuild(b)}`)),
		`${formatSize(plan.total)} → ${color.bold(formatSize(plan.after))} ${color.dim(`(max ${formatSize(max.data)})`)}`,
	].join("\n");
	emit(
		ctx,
		opts.json === true,
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

type ImportOpts = {
	hash: string;
	platform?: string;
	project?: string;
	profile?: string;
	bundleId?: string;
	json?: true;
};

async function importCmd(ctx: CommandContext, raw: string, opts: ImportOpts): Promise<number> {
	const artifact = resolve(ctx.cwd, raw).replace(/\/+$/, "");
	const platform = inferPlatform(artifact, opts.platform);
	if (!platform.success) return fail(ctx, "import", platform.error);
	const start = opts.project ? resolve(ctx.cwd, opts.project) : ctx.cwd;
	const bundle = opts.bundleId;
	const project = await projectContext({
		exec: ctx.exec,
		env: ctx.env,
		start,
		...(bundle !== undefined ? { bundleId: { [platform.data]: bundle } } : {}),
	});
	if (!project.success) return fail(ctx, "import", project.error);
	const stored = await withSpinner(ctx, `importing ${raw} into the build cache…`, () =>
		storeArtifact({
			store: ctx.store(),
			env: ctx.env,
			projectKey: project.data.projectKey,
			platform: platform.data,
			profile: opts.profile ?? project.data.project.eas?.profile ?? LOCAL_PROFILE,
			hash: opts.hash,
			artifact,
			source: "import",
			now: ctx.now(),
		})
	);
	if (!stored.success) return fail(ctx, "import", stored.error);
	const b = stored.data;
	emit(
		ctx,
		opts.json === true,
		b,
		`${ctx.ui.color.green("imported")} ${b.platform} ${b.hash} → ${b.path} ${ctx.ui.color.dim(`(${formatSize(b.size)})`)}`
	);
	return 0;
}

export const buildsCommand = defineCommand({
	name: "builds",
	summary: "list, prune (LRU) and import cached native app builds",
	register: (cmd, ctx, done) => {
		cmd
			.command("ls", { isDefault: true })
			.description("list cached builds (the default)")
			.option("--json", "machine-readable output")
			.action((opts) => done(lsCmd(ctx, opts.json === true)));
		cmd
			.command("prune")
			.description("remove least-recently-used builds until the cache fits --max-size (build-locked ones stay)")
			.option("--max-size <size>", `cache size limit, e.g. 20G (default ${DEFAULT_MAX_CACHE_SIZE})`)
			.option("--dry-run", "only show what would be removed")
			.option("--yes", "don't ask before removing")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await pruneCmd(ctx, opts)));
		cmd
			.command("import")
			.description("copy a local .app / .apk into the cache under a fingerprint hash")
			.argument("<path>", "path.app | path.apk")
			.requiredOption("--hash <hash>", "fingerprint hash to file it under")
			.option("--platform <platform>", "ios | android (default: from the extension)")
			.option("--project <dir>", "project directory (default: cwd)")
			.option("--profile <profile>", "build profile (default: the project's EAS profile, else local)")
			.option("--bundle-id <id>", "override the bundle id / package")
			.option("--json", "machine-readable output")
			.action(async (path, opts) => done(await importCmd(ctx, path, opts)));
	},
});
