import { basename, resolve } from "node:path";
import { DEFAULT_MAX_CACHE_SIZE } from "@delacour/warden-builds/builds.defaults";
import { buildCache } from "@delacour/warden-builds/cache";
import { compilerCache } from "@delacour/warden-builds/compiler-cache";
import { LOCAL_PROFILE } from "@delacour/warden-builds/ensure";
import { appLookup } from "@delacour/warden-builds/prepare";
import { prune as pruneTools } from "@delacour/warden-builds/prune";
import { remove as removeTools } from "@delacour/warden-builds/remove";
import { durationParser } from "@delacour/warden-config/duration";
import { type BuildRecord, BuildsTable } from "@delacour/warden-store/builds-table";
import { liveness } from "@delacour/warden-store/liveness";
import { storeLocator } from "@delacour/warden-store/store";
import type { Platform } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { claimFlagsHelpers } from "../claim-flags";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";
import { projectContextHelpers } from "../project-context";
import { spinnerContext } from "../spinner-context";

/** What a cached build is, flattened for `builds ls`: its kind, the native fingerprint it is keyed on, and a repack's / release's JS key and origin. */
export type BuildFacts = { kind: string; base?: string; jsKey?: string; worktree?: string; branch?: string };

type PruneOpts = { maxSize?: string; dryRun?: true; yes?: true; json?: true };

type RmOpts = { platform?: string; dryRun?: true; yes?: true; json?: true };

type ImportOpts = {
	hash: string;
	platform?: string;
	project?: string;
	profile?: string;
	bundleId?: string;
	json?: true;
};

export class BuildsCommand extends CliCommand {
	override readonly name = "builds";
	override readonly group = "Builds";
	override readonly summary = "list, remove, prune (LRU) and import cached native app builds";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.command("ls", { isDefault: true })
			.description("list cached builds (the default)")
			.option("--json", "machine-readable output")
			.action((opts) => done(this.lsCmd(ctx, opts.json === true)));
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
			.action(async (opts) => done(await this.pruneCmd(ctx, opts)));
		cmd
			.command("rm")
			.alias("remove")
			.description("remove cached builds by hash (or a unique prefix) and forget the installs at that hash")
			.argument("<hash...>", "hash or unique prefix (at least 6 characters), as `warden builds` shows it")
			.option("--platform <platform>", "ios | android: only builds of this platform")
			.option("--dry-run", "only show what would be removed")
			.option("--yes", "don't ask before removing")
			.option("--json", "machine-readable output")
			.action(async (hashes, opts) => done(await this.rmCmd(ctx, hashes, opts)));
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
			.action(async (path, opts) => done(await this.importCmd(ctx, path, opts)));
	}

	private fail(ctx: CommandContext, sub: string, message: string): number {
		output.reportError(ctx, `builds ${sub}`, message);
		return 1;
	}

	/** The kind / base / jsKey / worktree / branch of `b`; a pre-kind (legacy) row has only `kind: "legacy"`. */
	buildFacts(b: BuildRecord): BuildFacts {
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

	private lsCmd(ctx: CommandContext, json: boolean): number {
		const { color } = ctx.ui;
		const builds = new BuildsTable(ctx.store()).list();
		const now = ctx.now();
		const short = (value: string | undefined, length = 8) => (value === undefined ? "-" : value.slice(0, length));
		const rows = builds.map((b) => {
			const facts = this.buildFacts(b);
			return [
				b.projectKey,
				b.platform,
				color.bold(b.hash.slice(0, 12)),
				facts.kind,
				short(facts.base),
				short(facts.jsKey),
				facts.worktree === undefined ? "-" : basename(facts.worktree),
				facts.branch ?? "-",
				pruneTools.formatSize(b.size),
				`${durationParser.format(Math.max(0, now - b.lastUsedAt))} ago`,
				color.dim(b.path),
			];
		});
		const total = builds.reduce((s, b) => s + b.size, 0);
		const columns = [
			"PROJECT",
			"PLATFORM",
			"HASH",
			"KIND",
			"BASE",
			"JSKEY",
			"WORKTREE",
			"BRANCH",
			"SIZE",
			"AGE",
			"PATH",
		];
		const text =
			builds.length === 0
				? color.dim("no cached builds")
				: `${output.table(ctx, columns, rows, [
						{ column: 10, keep: "end", min: 20 },
						{ column: 0, keep: "end", min: 20 },
						{ column: 7, min: 12 },
						{ column: 6, min: 12 },
					])}\n\ntotal ${color.bold(pruneTools.formatSize(total))}`;
		const listed = builds.map((b) => ({ ...b, ...this.buildFacts(b) }));
		output.emit(ctx, json, { builds: listed, totalBytes: total }, text, {
			scope: "builds",
			detail: `${output.plural(builds.length, "build")} · ${pruneTools.formatSize(total)}`,
		});
		return 0;
	}

	private describeBuild(b: { projectKey: string; platform: string; hash: string; size: number }) {
		return `${b.projectKey} ${b.platform} ${b.hash} (${pruneTools.formatSize(b.size)})`;
	}

	/** List what an LRU prune removes and ask; true = go ahead (nothing to remove counts as yes). */
	private async confirmPrune(ctx: CommandContext, remove: readonly BuildRecord[]): Promise<boolean> {
		if (remove.length === 0) return true;
		for (const b of remove) output.warn(ctx, `will remove ${this.describeBuild(b)}`);
		const freed = remove.reduce((sum, b) => sum + b.size, 0);
		if ((await ctx.ui.confirm(`Remove ${remove.length} cached build(s) (${pruneTools.formatSize(freed)})?`)) === true)
			return true;
		ctx.ui.cancelled("Aborted.");
		return false;
	}

	/**
	 * LRU-prune the cache down to `--max-size` (else `WARDEN_MAX_CACHE_SIZE`, else 20G, the cap `warden gc`
	 * uses too). In a terminal (without `--yes` / `--dry-run`) shows
	 * what goes and asks first.
	 */
	private async pruneCmd(ctx: CommandContext, opts: PruneOpts): Promise<number> {
		const { ui } = ctx;
		const { color } = ui;
		const cap = pruneTools.cacheCap(opts.maxSize, ctx.env);
		const max = cap.bytes;
		if (!max.success)
			return this.fail(ctx, "prune", `${cap.source === "env" ? "WARDEN_MAX_CACHE_SIZE" : "--max-size"}: ${max.error}`);
		const dryRun = opts.dryRun === true;
		const prune = (dry: boolean) =>
			pruneTools.builds({
				store: ctx.store(),
				env: ctx.env,
				maxBytes: max.data,
				now: ctx.now(),
				pidAlive: liveness.processAlive,
				dryRun: dry,
			});
		const preview = prune(true);
		if (!opts.json) {
			output.heading(
				ctx,
				"builds prune",
				`${output.plural(preview.remove.length, "build")} over ${pruneTools.formatSize(max.data)}${dryRun ? " · dry run" : ""}`
			);
		}
		if (!dryRun && ui.interactive && !opts.yes && !(await this.confirmPrune(ctx, preview.remove))) return 1;
		const plan = dryRun
			? preview
			: await spinnerContext.withSpinner(ctx, `pruning ${preview.remove.length} build(s)…`, async () => prune(false));
		if (!dryRun) await compilerCache.ccacheCleanup(ctx.exec, storeLocator.wardenHome(ctx.env));
		const verb = dryRun ? "would remove" : "removed";
		const text = [
			...plan.remove.map((b) => (dryRun ? color.yellow : color.green)(`${verb} ${this.describeBuild(b)}`)),
			`${pruneTools.formatSize(plan.total)} → ${color.bold(pruneTools.formatSize(plan.after))} ${color.dim(`(max ${pruneTools.formatSize(max.data)})`)}`,
		].join("\n");
		output.emit(
			ctx,
			opts.json === true,
			{ dryRun, removed: plan.remove, totalBytes: plan.total, afterBytes: plan.after, maxBytes: max.data },
			text
		);
		return 0;
	}

	/**
	 * Remove the named cached builds (a hash or unique prefix each), their aliases, and the install records at
	 * their hashes: a bad build (made from a stale native dir) is dropped and the next `ensure` builds it again.
	 */
	private async rmCmd(ctx: CommandContext, prefixes: string[], opts: RmOpts): Promise<number> {
		const { color } = ctx.ui;
		let platform: Platform | undefined;
		if (opts.platform !== undefined) {
			const parsed = claimFlagsHelpers.parsePlatform(opts.platform);
			if (!parsed.success) return this.fail(ctx, "rm", parsed.error);
			platform = parsed.data;
		}
		const dryRun = opts.dryRun === true;
		const remove = (dry: boolean) =>
			removeTools.builds({
				store: ctx.store(),
				env: ctx.env,
				prefixes,
				...(platform !== undefined ? { platform } : {}),
				now: ctx.now(),
				pidAlive: liveness.processAlive,
				dryRun: dry,
			});
		const preview = remove(true);
		if (!preview.success) return this.fail(ctx, "rm", preview.error);
		if (!opts.json)
			output.heading(
				ctx,
				"builds rm",
				`${output.plural(preview.data.remove.length, "build")}${dryRun ? " · dry run" : ""}`
			);
		if (!dryRun && ctx.ui.interactive && !opts.yes && !(await this.confirmPrune(ctx, preview.data.remove))) return 1;
		const done = dryRun ? preview : remove(false);
		if (!done.success) return this.fail(ctx, "rm", done.error);
		const { remove: removed, forgotInstalls } = done.data;
		const verb = dryRun ? "would remove" : "removed";
		const text = [
			...removed.map((b) => (dryRun ? color.yellow : color.green)(`${verb} ${this.describeBuild(b)}`)),
			color.dim(
				`${dryRun ? "would forget" : "forgot"} ${output.plural(forgotInstalls, "install record")}: the next ensure reinstalls there`
			),
		].join("\n");
		output.emit(ctx, opts.json === true, { dryRun, removed, forgotInstalls }, text);
		return 0;
	}

	/** `.app` → ios, `.apk` → android, unless `--platform` says otherwise. */
	inferPlatform(path: string, flag: string | undefined): Result<Platform> {
		if (flag !== undefined) return claimFlagsHelpers.parsePlatform(flag);
		const clean = path.replace(/\/+$/, "");
		if (clean.endsWith(".app")) return resultFactory.ok("ios");
		if (clean.endsWith(".apk")) return resultFactory.ok("android");
		return resultFactory.err(`can't tell the platform of ${path} — pass --platform ios|android`);
	}

	private async importCmd(ctx: CommandContext, raw: string, opts: ImportOpts): Promise<number> {
		const artifact = resolve(ctx.cwd, raw).replace(/\/+$/, "");
		const platform = this.inferPlatform(artifact, opts.platform);
		if (!platform.success) return this.fail(ctx, "import", platform.error);
		const start = appLookup.projectStart(ctx, opts.project);
		if (!start.success) return this.fail(ctx, "import", start.error);
		const bundle = opts.bundleId;
		const project = await projectContextHelpers.projectContextFor(ctx, {
			start: start.data,
			...(bundle !== undefined ? { bundleId: { [platform.data]: bundle } } : {}),
		});
		if (!project.success) return this.fail(ctx, "import", project.error);
		const stored = await spinnerContext.withSpinner(ctx, `importing ${raw} into the build cache…`, () =>
			buildCache.storeArtifact({
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
		if (!stored.success) return this.fail(ctx, "import", stored.error);
		const b = stored.data;
		output.emit(
			ctx,
			opts.json === true,
			b,
			`${ctx.ui.color.green("imported")} ${b.platform} ${b.hash} → ${b.path} ${ctx.ui.color.dim(`(${pruneTools.formatSize(b.size)})`)}`
		);
		return 0;
	}
}

export const buildsCli = new BuildsCommand();
export const buildsCommand = buildsCli.definition();
