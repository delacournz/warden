import { basename, resolve } from "node:path";
import { DEFAULT_MAX_CACHE_SIZE } from "@delacour/warden-core/builds/builds.defaults";
import {
	type BuildRecord,
	type KindLayout,
	kindDir,
	kindHash,
	listBuilds,
	storeArtifact,
} from "@delacour/warden-core/builds/cache";
import { ccacheCleanup } from "@delacour/warden-core/builds/compiler-cache";
import { devBuildHash, findDevBuild } from "@delacour/warden-core/builds/dev-build";
import { LOCAL_PROFILE, type ProjectContext } from "@delacour/warden-core/builds/ensure";
import { checkSimulatorBase, hostSimulatorArch } from "@delacour/warden-core/builds/import-base";
import { checkDevBuild } from "@delacour/warden-core/builds/import-dev";
import { kindFingerprints } from "@delacour/warden-core/builds/kind-key";
import { kindlessIsDev } from "@delacour/warden-core/builds/kinds";
import { cacheCap, formatSize, pruneBuilds } from "@delacour/warden-core/builds/prune";
import { removeBuilds } from "@delacour/warden-core/builds/remove";
import { formatDuration } from "@delacour/warden-core/duration";
import { processAlive } from "@delacour/warden-core/liveness";
import { wardenHome } from "@delacour/warden-core/store";
import type { Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
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
	hash?: string;
	kind?: string;
	platform?: string;
	project?: string;
	profile?: string;
	bundleId?: string;
	json?: true;
};

/** `--kind` values `builds import` accepts: the kind-less (legacy) row, a simulator base repacks clone from, or the dev build. */
const IMPORT_KINDS = ["simulator-base", "dev"] as const;
type ImportKind = (typeof IMPORT_KINDS)[number];

function parseImportKind(value: string | undefined): Result<ImportKind | undefined> {
	if (value === undefined) return ok(undefined);
	const kind = IMPORT_KINDS.find((k) => k === value);
	return kind ? ok(kind) : err(`--kind ${value}: expected ${IMPORT_KINDS.join(" | ")}`);
}

/** `<nativeFp>` or `<nativeFp>:base` → `<nativeFp>`. */
const baseFingerprint = (hash: string) => hash.replace(/:base$/, "");

type ImportTarget = {
	hash: string;
	profile: string;
	layout?: KindLayout;
	strippedBundle?: boolean;
	/** the base's entitlements: false = none (a `-34018` Keychain failure waits in the app), undefined = not known */
	applicationIdentifier?: boolean;
};

/**
 * A `simulator-base` import: check the `.app` (simulator slice for this Mac, the project's bundle id, Release), key it on
 * `--hash` or warden's own simulator-kind native fingerprint of the project, and lay it out where `warden repack` /
 * `warden e2e` look for the base.
 */
async function simulatorBaseTarget(
	ctx: CommandContext,
	project: ProjectContext,
	artifact: string,
	opts: ImportOpts
): AsyncResult<ImportTarget> {
	const bundleId = project.project.bundleId.ios;
	if (bundleId === undefined) return err("the project has no iOS bundle id: pass --bundle-id");
	const facts = await checkSimulatorBase(ctx.exec, artifact, { bundleId, arch: hostSimulatorArch() });
	if (!facts.success) return facts;
	let nativeFp = opts.hash === undefined ? undefined : baseFingerprint(opts.hash);
	if (nativeFp === undefined) {
		const fps = await kindFingerprints({
			exec: ctx.exec,
			project: project.project,
			platform: "ios",
			kind: "simulator",
			env: ctx.env,
			memo: { store: ctx.store(), now: ctx.now() },
		});
		if (!fps.success) return fps;
		nativeFp = fps.data.nativeFp;
	}
	const key = { kind: "simulator-base", nativeFp } as const;
	return ok({
		hash: kindHash(key),
		profile: `${opts.profile ?? project.project.eas?.profile ?? LOCAL_PROFILE}:simulator`,
		layout: { dir: kindDir(ctx.env, project.projectKey, "ios", key), kind: "simulator-base" },
		strippedBundle: facts.data.embeddedBundle,
		...(facts.data.applicationIdentifier !== undefined
			? { applicationIdentifier: facts.data.applicationIdentifier }
			: {}),
	});
}

/**
 * A `dev` import: check the `.app` (Debug simulator build of the project's bundle id, slice for this Mac) and key it on
 * `--hash` (`<nativeFp>` or `<nativeFp>:dev`) or warden's own dev-kind native fingerprint, where `warden app ensure --kind dev` looks.
 */
async function devTarget(
	ctx: CommandContext,
	project: ProjectContext,
	artifact: string,
	opts: ImportOpts
): AsyncResult<ImportTarget> {
	const bundleId = project.project.bundleId.ios;
	if (bundleId === undefined) return err("the project has no iOS bundle id: pass --bundle-id");
	const facts = await checkDevBuild(ctx.exec, artifact, { bundleId, arch: hostSimulatorArch() });
	if (!facts.success) return facts;
	let nativeFp = opts.hash === undefined ? undefined : devBuildHash(opts.hash).nativeFp;
	if (nativeFp === undefined) {
		const fps = await kindFingerprints({
			exec: ctx.exec,
			project: project.project,
			platform: "ios",
			kind: "dev",
			env: ctx.env,
			memo: { store: ctx.store(), now: ctx.now() },
		});
		if (!fps.success) return fps;
		nativeFp = fps.data.nativeFp;
	}
	const key = { kind: "dev", nativeFp } as const;
	return ok({
		hash: kindHash(key),
		profile: `${opts.profile ?? project.project.eas?.profile ?? LOCAL_PROFILE}:dev`,
		layout: { dir: kindDir(ctx.env, project.projectKey, "ios", key), kind: "dev" },
	});
}

/** The artifact path, its platform and `--kind`, checked against each other before any work. */
function importArgs(
	ctx: CommandContext,
	raw: string,
	opts: ImportOpts
): Result<{ artifact: string; platform: Platform; kind: ImportKind | undefined }> {
	const artifact = resolve(ctx.cwd, raw).replace(/\/+$/, "");
	const platform = inferPlatform(artifact, opts.platform);
	if (!platform.success) return platform;
	const kind = parseImportKind(opts.kind);
	if (!kind.success) return kind;
	if (kind.data === "simulator-base" && platform.data !== "ios")
		return err("--kind simulator-base takes an iOS simulator .app (Android bases are built by warden)");
	if (kind.data === "dev" && platform.data !== "ios") return err("--kind dev takes an iOS simulator .app (iOS only)");
	if (kind.data === undefined && opts.hash === undefined) return err("--hash <hash> is required without --kind");
	return ok({ artifact, platform: platform.data, kind: kind.data });
}

/** The cache key and layout of the import: `kind`'s own (checked, fingerprinted), or the plain `--hash`. */
async function importTarget(
	ctx: CommandContext,
	kind: ImportKind | undefined,
	project: ProjectContext,
	artifact: string,
	raw: string,
	opts: ImportOpts
): AsyncResult<ImportTarget> {
	const resolveKind = kind === "simulator-base" ? simulatorBaseTarget : kind === "dev" ? devTarget : undefined;
	if (resolveKind === undefined) {
		return ok({ hash: opts.hash ?? "", profile: opts.profile ?? project.project.eas?.profile ?? LOCAL_PROFILE });
	}
	return withSpinner(ctx, `checking ${raw} and fingerprinting the project…`, (sctx) =>
		resolveKind(sctx, project, artifact, opts)
	);
}

async function importCmd(ctx: CommandContext, raw: string, opts: ImportOpts): Promise<number> {
	const args = importArgs(ctx, raw, opts);
	if (!args.success) return fail(ctx, "import", args.error);
	const { artifact, platform, kind } = args.data;
	const start = projectStart(ctx, opts.project);
	if (!start.success) return fail(ctx, "import", start.error);
	const bundle = opts.bundleId;
	const project = await projectContextFor(ctx, {
		start: start.data,
		...(bundle !== undefined ? { bundleId: { [platform]: bundle } } : {}),
	});
	if (!project.success) return fail(ctx, "import", project.error);
	const target = await importTarget(ctx, kind, project.data, artifact, raw, opts);
	if (!target.success) return fail(ctx, "import", target.error);
	const { layout, strippedBundle, applicationIdentifier } = target.data;
	if (applicationIdentifier === false) {
		warn(
			ctx,
			`${raw} has no application-identifier entitlement: Keychain calls fail in the simulator with errSecMissingEntitlement (-34018). Build it with CODE_SIGN_IDENTITY=- (ad-hoc signing), not CODE_SIGNING_ALLOWED=NO`
		);
	}
	const stored = await withSpinner(ctx, `importing ${raw} into the build cache…`, () =>
		storeArtifact({
			store: ctx.store(),
			env: ctx.env,
			projectKey: project.data.projectKey,
			platform,
			profile: target.data.profile,
			hash: target.data.hash,
			artifact,
			source: "import",
			...(layout ? { layout } : {}),
			now: ctx.now(),
		})
	);
	if (!stored.success) return fail(ctx, "import", stored.error);
	const b = stored.data;
	const note = strippedBundle ? ctx.ui.color.dim(" · embedded main.jsbundle stripped (repacks write their own)") : "";
	emit(
		ctx,
		opts.json === true,
		{
			...b,
			...(strippedBundle !== undefined ? { strippedBundle } : {}),
			...(applicationIdentifier !== undefined ? { applicationIdentifier } : {}),
		},
		`${ctx.ui.color.green("imported")} ${b.platform}${b.kind ? ` ${b.kind}` : ""} ${b.hash} → ${b.path} ${ctx.ui.color.dim(`(${formatSize(b.size)})`)}${note}`
	);
	return 0;
}

type PathOpts = { kind?: string; hash?: string; project?: string; bundleId?: string; json?: true };

/** Exit code of `builds path` when nothing is cached for the hash (1 is a usage / project error). */
export const PATH_MISS_EXIT = 2;

/**
 * Where the cached dev build of this project is, without building, downloading or writing a row: `--hash`
 * (`<nativeFp>` or `<nativeFp>:dev`, default warden's own dev-kind fingerprint) looked up the way `app ensure --kind dev`
 * finds it. `defaultBuild` says whether the project's plain native build (what `expo run:ios` makes) is that dev build.
 */
async function pathCmd(ctx: CommandContext, platformArg: string, opts: PathOpts): Promise<number> {
	const platform = parsePlatform(platformArg);
	if (!platform.success) return fail(ctx, "path", platform.error);
	if (opts.kind !== undefined && opts.kind !== "dev") return fail(ctx, "path", `--kind ${opts.kind}: expected dev`);
	const start = projectStart(ctx, opts.project);
	if (!start.success) return fail(ctx, "path", start.error);
	const bundle = opts.bundleId;
	const project = await projectContextFor(ctx, {
		start: start.data,
		...(bundle !== undefined ? { bundleId: { [platform.data]: bundle } } : {}),
	});
	if (!project.success) return fail(ctx, "path", project.error);
	let nativeFp = opts.hash === undefined ? undefined : devBuildHash(opts.hash).nativeFp;
	if (nativeFp === undefined) {
		const fps = await kindFingerprints({
			exec: ctx.exec,
			project: project.data.project,
			platform: platform.data,
			kind: "dev",
			env: ctx.env,
			memo: { store: ctx.store(), now: ctx.now() },
		});
		if (!fps.success) return fail(ctx, "path", fps.error);
		nativeFp = fps.data.nativeFp;
	}
	const defaultBuild = kindlessIsDev(project.data.project, platform.data);
	const { hash } = devBuildHash(nativeFp);
	const found = findDevBuild(ctx.store(), {
		projectKey: project.data.projectKey,
		platform: platform.data,
		hash,
		kindlessIsDev: defaultBuild,
		now: ctx.now(),
	});
	if (!found) {
		if (opts.json !== true) ctx.err(`no cached dev build for ${hash}`);
		emit(ctx, opts.json === true, { found: false, hash, defaultBuild }, "");
		return PATH_MISS_EXIT;
	}
	emit(
		ctx,
		opts.json === true,
		{ found: true, hash, path: found.path, platform: platform.data, kind: "dev", defaultBuild },
		found.path
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
			.command("path")
			.description(
				"print where this project's cached dev build is (exit 2 on a miss); never builds or downloads. The Expo build-cache provider calls it"
			)
			.argument("<platform>", "ios | android")
			.option("--kind <kind>", "dev (the only kind)")
			.option("--hash <hash>", "<nativeFp> or <nativeFp>:dev to look up (default: warden's own dev-kind fingerprint)")
			.option("--project <dir>", "project directory (default: cwd)")
			.option("--bundle-id <id>", "override the bundle id / package")
			.option("--json", "machine-readable output")
			.action(async (platform, opts) => done(await pathCmd(ctx, platform, opts)));
		cmd
			.command("import")
			.description(
				"copy a local .app / .apk into the cache under a fingerprint hash (--kind simulator-base: a CI-built Release simulator .app that repacks clone from; --kind dev: a Debug simulator .app)"
			)
			.argument("<path>", "path.app | path.apk")
			.option(
				"--hash <hash>",
				"fingerprint hash to file it under (required without --kind; simulator-base / dev: <nativeFp>, default warden's own)"
			)
			.option(
				"--kind <kind>",
				"simulator-base: file it as the base `warden repack` / `warden e2e` reuse; dev: file a Debug simulator .app as the project's dev build (--hash <nativeFp>[:dev])"
			)
			.option("--platform <platform>", "ios | android (default: from the extension)")
			.option("--project <dir>", "project directory (default: cwd)")
			.option("--profile <profile>", "build profile (default: the project's EAS profile, else local)")
			.option("--bundle-id <id>", "override the bundle id / package")
			.option("--json", "machine-readable output")
			.action(async (path, opts) => done(await importCmd(ctx, path, opts)));
	},
});
