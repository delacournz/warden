import { basename, resolve } from "node:path";
import { DEFAULT_MAX_CACHE_SIZE } from "@delacour/warden-core/builds/builds.defaults";
import { type BuildRecord, listBuilds, storeArtifact } from "@delacour/warden-core/builds/cache";
import { ccacheCleanup } from "@delacour/warden-core/builds/compiler-cache";
import { LOCAL_PROFILE } from "@delacour/warden-core/builds/ensure";
import { cacheCap, formatSize, pruneBuilds } from "@delacour/warden-core/builds/prune";
import { removeBuilds } from "@delacour/warden-core/builds/remove";
import { formatDuration } from "@delacour/warden-core/duration";
import { processAlive } from "@delacour/warden-core/liveness";
import { wardenHome } from "@delacour/warden-core/store";
import type { Platform } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { parsePlatform } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, heading, plural, reportError, table, warn } from "../output";
import { projectContextFor } from "../project-context";
import { withSpinner } from "../spinner-context";
import { projectStart } from "./app";

function fail(ctx: CommandContext, sub: string, message: string): number {
	reportError(ctx, `builds ${sub}`, message);
	return 1;
}

/** What a cached build is, flattened for `builds ls`: its kind, the native fingerprint it is keyed on, and a repack's / release's JS key and origin. */
export type BuildFacts = { kind: string; base?: string; jsKey?: string; worktree?: string; branch?: string };

/** The kind / base / jsKey / worktree / branch of `b`; a pre-kind (legacy) row has only `kind: "legacy"`. */
export function buildFacts(b: BuildRecord): BuildFacts {
	switch (b.kind) {
		case undefined:
		case "legacy":
			return { kind: "legacy" };
		case "dev":
		case "simulator-base":
			return { kind: b.kind, base: b.hash.split(":")[0] ?? b.hash };
		case "release":
			return { kind: b.kind, base: b.hash.split(":")[0] ?? b.hash, jsKey: b.jsKey };
		case "simulator-repack":
			return {
				kind: b.kind,
				base: b.baseHash.split(":")[0] ?? b.baseHash,
				jsKey: b.jsKey,
				...(b.worktree !== undefined ? { worktree: b.worktree } : {}),
				...(b.branch !== undefined ? { branch: b.branch } : {}),
			};
	}
}

function lsCmd(ctx: CommandContext, json: boolean): number {
	const { color } = ctx.ui;
	const builds = listBuilds(ctx.store());
	const now = ctx.now();
	const short = (value: string | undefined, length = 8) => (value === undefined ? "-" : value.slice(0, length));
	const rows = builds.map((b) => {
		const facts = buildFacts(b);
		return [
			b.projectKey,
			b.platform,
			color.bold(b.hash.slice(0, 12)),
			facts.kind,
			short(facts.base),
			short(facts.jsKey),
			facts.worktree === undefined ? "-" : basename(facts.worktree),
			facts.branch ?? "-",
			formatSize(b.size),
			`${formatDuration(Math.max(0, now - b.lastUsedAt))} ago`,
			color.dim(b.path),
		];
	});
	const total = builds.reduce((s, b) => s + b.size, 0);
	const columns = ["PROJECT", "PLATFORM", "HASH", "KIND", "BASE", "JSKEY", "WORKTREE", "BRANCH", "SIZE", "AGE", "PATH"];
	const text =
		builds.length === 0
			? color.dim("no cached builds")
			: `${table(ctx, columns, rows, [
					{ column: 10, keep: "end", min: 20 },
					{ column: 0, keep: "end", min: 20 },
					{ column: 7, min: 12 },
					{ column: 6, min: 12 },
				])}\n\ntotal ${color.bold(formatSize(total))}`;
	const listed = builds.map((b) => ({ ...b, ...buildFacts(b) }));
	emit(ctx, json, { builds: listed, totalBytes: total }, text, {
		scope: "builds",
		detail: `${plural(builds.length, "build")} · ${formatSize(total)}`,
	});
	return 0;
}

type PruneOpts = { maxSize?: string; dryRun?: true; yes?: true; json?: true };

const describeBuild = (b: { projectKey: string; platform: string; hash: string; size: number }) =>
	`${b.projectKey} ${b.platform} ${b.hash} (${formatSize(b.size)})`;

/** List what an LRU prune removes and ask; true = go ahead (nothing to remove counts as yes). */
async function confirmPrune(ctx: CommandContext, remove: readonly BuildRecord[]): Promise<boolean> {
	if (remove.length === 0) return true;
	for (const b of remove) warn(ctx, `will remove ${describeBuild(b)}`);
	const freed = remove.reduce((sum, b) => sum + b.size, 0);
	if ((await ctx.ui.confirm(`Remove ${remove.length} cached build(s) (${formatSize(freed)})?`)) === true) return true;
	ctx.ui.cancelled("Aborted.");
	return false;
}

/**
 * LRU-prune the cache down to `--max-size` (else `WARDEN_MAX_CACHE_SIZE`, else 20G, the cap `warden gc`
 * uses too). In a terminal (without `--yes` / `--dry-run`) shows
 * what goes and asks first.
 */
async function pruneCmd(ctx: CommandContext, opts: PruneOpts): Promise<number> {
	const { ui } = ctx;
	const { color } = ui;
	const cap = cacheCap(opts.maxSize, ctx.env);
	const max = cap.bytes;
	if (!max.success)
		return fail(ctx, "prune", `${cap.source === "env" ? "WARDEN_MAX_CACHE_SIZE" : "--max-size"}: ${max.error}`);
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
	if (!opts.json) {
		heading(
			ctx,
			"builds prune",
			`${plural(preview.remove.length, "build")} over ${formatSize(max.data)}${dryRun ? " · dry run" : ""}`
		);
	}
	if (!dryRun && ui.interactive && !opts.yes && !(await confirmPrune(ctx, preview.remove))) return 1;
	const plan = dryRun
		? preview
		: await withSpinner(ctx, `pruning ${preview.remove.length} build(s)…`, async () => prune(false));
	if (!dryRun) await ccacheCleanup(ctx.exec, wardenHome(ctx.env));
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

type RmOpts = { platform?: string; dryRun?: true; yes?: true; json?: true };

/**
 * Remove the named cached builds (a hash or unique prefix each), their aliases, and the install records at
 * their hashes: a bad build (made from a stale native dir) is dropped and the next `ensure` builds it again.
 */
async function rmCmd(ctx: CommandContext, prefixes: string[], opts: RmOpts): Promise<number> {
	const { color } = ctx.ui;
	let platform: Platform | undefined;
	if (opts.platform !== undefined) {
		const parsed = parsePlatform(opts.platform);
		if (!parsed.success) return fail(ctx, "rm", parsed.error);
		platform = parsed.data;
	}
	const dryRun = opts.dryRun === true;
	const remove = (dry: boolean) =>
		removeBuilds({
			store: ctx.store(),
			env: ctx.env,
			prefixes,
			...(platform !== undefined ? { platform } : {}),
			now: ctx.now(),
			pidAlive: processAlive,
			dryRun: dry,
		});
	const preview = remove(true);
	if (!preview.success) return fail(ctx, "rm", preview.error);
	if (!opts.json)
		heading(ctx, "builds rm", `${plural(preview.data.remove.length, "build")}${dryRun ? " · dry run" : ""}`);
	if (!dryRun && ctx.ui.interactive && !opts.yes && !(await confirmPrune(ctx, preview.data.remove))) return 1;
	const done = dryRun ? preview : remove(false);
	if (!done.success) return fail(ctx, "rm", done.error);
	const { remove: removed, forgotInstalls } = done.data;
	const verb = dryRun ? "would remove" : "removed";
	const text = [
		...removed.map((b) => (dryRun ? color.yellow : color.green)(`${verb} ${describeBuild(b)}`)),
		color.dim(
			`${dryRun ? "would forget" : "forgot"} ${plural(forgotInstalls, "install record")}: the next ensure reinstalls there`
		),
	].join("\n");
	emit(ctx, opts.json === true, { dryRun, removed, forgotInstalls }, text);
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
	const start = projectStart(ctx, opts.project);
	if (!start.success) return fail(ctx, "import", start.error);
	const bundle = opts.bundleId;
	const project = await projectContextFor(ctx, {
		start: start.data,
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
	group: "Builds",
	summary: "list, remove, prune (LRU) and import cached native app builds",
	register: (cmd, ctx, done) => {
		cmd
			.command("ls", { isDefault: true })
			.description("list cached builds (the default)")
			.option("--json", "machine-readable output")
			.action((opts) => done(lsCmd(ctx, opts.json === true)));
		cmd
			.command("prune")
			.description("remove least-recently-used builds until the cache fits --max-size (build-locked ones stay)")
			.option(
				"--max-size <size>",
				`cache size limit, e.g. 20G (default: $WARDEN_MAX_CACHE_SIZE or ${DEFAULT_MAX_CACHE_SIZE}; gc's --max-cache-size)`
			)
			.option("--dry-run", "only show what would be removed")
			.option("--yes", "don't ask before removing")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await pruneCmd(ctx, opts)));
		cmd
			.command("rm")
			.alias("remove")
			.description("remove cached builds by hash (or a unique prefix) and forget the installs at that hash")
			.argument("<hash...>", "hash or unique prefix (at least 6 characters), as `warden builds` shows it")
			.option("--platform <platform>", "ios | android: only builds of this platform")
			.option("--dry-run", "only show what would be removed")
			.option("--yes", "don't ask before removing")
			.option("--json", "machine-readable output")
			.action(async (hashes, opts) => done(await rmCmd(ctx, hashes, opts)));
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
