import { formatSize, parseSize } from "@delacour/warden-core/builds/prune";
import { formatDuration, parseDuration } from "@delacour/warden-core/duration";
import { processAlive } from "@delacour/warden-core/liveness";
import type { PodsDeps, PodsEntry, PodsInstallOptions, PodsOutcome } from "@delacour/warden-core/pods/pods.types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import type { PodsInstallJson } from "../contracts/pods.schema";
import { SCHEMA_VERSIONS } from "../contracts/versions";
import { emit, heading, plural, reportError, table, warn } from "../output";
import { DEFAULT_PODS_MAX_AGE, DEFAULT_PODS_MAX_SIZE } from "../pods-defaults";
import { projectContextFor } from "../project-context";
import { projectStart } from "./app";

/** Effects `pods` needs beyond `CommandContext`: injectable for tests. */
export type PodsCommandDeps = {
	pid: number;
	sleep: (ms: number) => Promise<void>;
	pidAlive: (pid: number) => boolean;
	/** the pods cache install (imported on first use) */
	install: (deps: PodsDeps, opts: PodsInstallOptions) => AsyncResult<PodsOutcome>;
};

export const defaultPodsDeps: PodsCommandDeps = {
	pid: process.pid,
	sleep: (ms) => Bun.sleep(ms),
	pidAlive: processAlive,
	install: async (deps, opts) => (await import("@delacour/warden-core/pods/pods-install")).podsInstall(deps, opts),
};

/** `warden pods rm` takes at least this many characters of a key. */
const MIN_KEY_PREFIX = 6;

function fail(ctx: CommandContext, sub: string, message: string): number {
	reportError(ctx, `pods ${sub}`, message);
	return 1;
}

const shortKey = (key: string) => key.slice(0, 12);

type InstallOpts = { projectDirectory?: string; cache?: boolean; json?: true };

/** The `warden pods install --json` document of an outcome. */
export function installJson(outcome: PodsOutcome): PodsInstallJson {
	const schemaVersion = SCHEMA_VERSIONS["warden.pods.install"];
	switch (outcome.kind) {
		case "hit":
		case "up-to-date":
			return { schemaVersion, outcome: outcome.kind, key: outcome.key, mode: outcome.mode, ms: outcome.ms };
		case "miss":
			return {
				schemaVersion,
				outcome: "miss",
				key: outcome.key,
				mode: outcome.mode,
				ms: outcome.ms,
				stored: outcome.stored,
				...(outcome.storeError !== undefined ? { storeError: outcome.storeError } : {}),
			};
		case "uncached":
			return { schemaVersion, outcome: "uncached", reason: outcome.reason, ms: outcome.ms };
	}
}

function installText(ctx: CommandContext, outcome: PodsOutcome): string {
	const { color } = ctx.ui;
	const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
	switch (outcome.kind) {
		case "hit":
			return color.green(`✓ pods restored ${shortKey(outcome.key)} (${secs(outcome.ms)})`);
		case "up-to-date":
			return color.dim("· pods up to date");
		case "miss":
			return outcome.stored
				? color.green(`✓ pods installed and cached ${shortKey(outcome.key)} (${secs(outcome.ms)})`)
				: color.yellow(`! pods installed, not cached: ${outcome.storeError ?? "unknown error"}`);
		case "uncached":
			return color.yellow(`! pods installed, not cached: ${outcome.reason}`);
	}
}

/**
 * `pod install` through the machine-wide pods cache, from the project the command runs in. Pod output streams to
 * stderr; stdout carries one status line (or the `--json` document).
 */
async function installCmd(
	ctx: CommandContext,
	deps: PodsCommandDeps,
	podArgs: readonly string[],
	opts: InstallOpts
): Promise<number> {
	const start = projectStart(ctx, undefined);
	if (!start.success) return fail(ctx, "install", start.error);
	const project = await projectContextFor(ctx, { start: start.data });
	if (!project.success) return fail(ctx, "install", project.error);
	const { project: p } = project.data;
	if (!opts.json) heading(ctx, "pods install", p.name);
	const outcome = await deps.install(
		{
			store: ctx.store(),
			exec: ctx.exec,
			env: ctx.env,
			now: ctx.now,
			log: (line) => ctx.err(line),
			pid: deps.pid,
			pidAlive: deps.pidAlive,
			sleep: deps.sleep,
			owner: resolveOwner(ctx),
		},
		{
			projectRoot: p.root,
			...(opts.projectDirectory !== undefined ? { iosDir: opts.projectDirectory } : {}),
			...(opts.cache === false ? { noCache: true } : {}),
			...(podArgs.length > 0 ? { podArgs } : {}),
			framework: p.framework,
			...(p.prebuiltReactNative === false ? { prebuiltReactNative: false as const } : {}),
		}
	);
	if (!outcome.success) return fail(ctx, "install", outcome.error);
	emit(ctx, opts.json === true, installJson(outcome.data), installText(ctx, outcome.data));
	return 0;
}

const ago = (ctx: CommandContext, at: number) => `${formatDuration(Math.max(0, ctx.now() - at))} ago`;

async function lsCmd(ctx: CommandContext, json: boolean): Promise<number> {
	const { listPodsEntries } = await import("@delacour/warden-core/pods/pods-store");
	const { color } = ctx.ui;
	const entries = listPodsEntries(ctx.store());
	const total = entries.reduce((s, e) => s + e.sizeBytes, 0);
	const rows = entries.map((e) => [
		color.bold(shortKey(e.key)),
		e.mode,
		e.projectRel,
		formatSize(e.sizeBytes),
		ago(ctx, e.lastUsedAt),
		ago(ctx, e.createdAt),
	]);
	const text =
		entries.length === 0
			? color.dim("no cached pods")
			: `${table(ctx, ["KEY", "MODE", "PROJECT", "SIZE", "LAST USED", "CREATED"], rows, [{ column: 2, keep: "end", min: 12 }])}\n\ntotal ${color.bold(formatSize(total))} ${color.dim("(apparent: blocks are shared with the worktrees cloned from them)")}`;
	emit(ctx, json, { entries, totalBytes: total }, text, {
		scope: "pods",
		detail: `${plural(entries.length, "entry", "entries")} · ${formatSize(total)}`,
	});
	return 0;
}

type RmOpts = { dryRun?: true; json?: true };

/** Each prefix names exactly one entry (at least `MIN_KEY_PREFIX` characters); none locked right now. */
function planRm(
	entries: readonly PodsEntry[],
	prefixes: readonly string[],
	live: ReadonlySet<string>
): Result<PodsEntry[]> {
	const picked: PodsEntry[] = [];
	for (const prefix of prefixes) {
		if (prefix.length < MIN_KEY_PREFIX)
			return err(`key prefix ${prefix} is too short (at least ${MIN_KEY_PREFIX} characters)`);
		const found = entries.filter((e) => e.key.startsWith(prefix));
		const [only, ...rest] = found;
		if (only === undefined) return err(`no cached pods match ${prefix} (see \`warden pods ls\`)`);
		if (rest.length > 0) return err(`${prefix} matches ${found.length} entries: pass a longer key`);
		if (live.has(only.key)) return err(`${shortKey(only.key)} is being installed right now`);
		if (!picked.includes(only)) picked.push(only);
	}
	return ok(picked);
}

const describeEntry = (e: PodsEntry) => `${shortKey(e.key)} ${e.mode} ${e.projectRel} (${formatSize(e.sizeBytes)})`;

async function rmCmd(ctx: CommandContext, deps: PodsCommandDeps, prefixes: string[], opts: RmOpts): Promise<number> {
	const { listPodsEntries, livePodsKeys, removePodsEntry } = await import("@delacour/warden-core/pods/pods-store");
	const { color } = ctx.ui;
	const store = ctx.store();
	const planned = planRm(listPodsEntries(store), prefixes, livePodsKeys(store, ctx.now(), deps.pidAlive));
	if (!planned.success) return fail(ctx, "rm", planned.error);
	const dryRun = opts.dryRun === true;
	if (!opts.json)
		heading(ctx, "pods rm", `${plural(planned.data.length, "entry", "entries")}${dryRun ? " · dry run" : ""}`);
	if (!dryRun) for (const e of planned.data) removePodsEntry(store, ctx.env, e.key);
	const verb = dryRun ? "would remove" : "removed";
	emit(
		ctx,
		opts.json === true,
		{ dryRun, removed: planned.data },
		planned.data.map((e) => (dryRun ? color.yellow : color.green)(`${verb} ${describeEntry(e)}`)).join("\n")
	);
	return 0;
}

type PruneOpts = { maxSize?: string; olderThan?: string; dryRun?: true; json?: true };

async function pruneCmd(ctx: CommandContext, deps: PodsCommandDeps, opts: PruneOpts): Promise<number> {
	const maxBytes = parseSize(opts.maxSize ?? DEFAULT_PODS_MAX_SIZE);
	if (!maxBytes.success) return fail(ctx, "prune", `--max-size: ${maxBytes.error}`);
	const olderThan = parseDuration(opts.olderThan ?? DEFAULT_PODS_MAX_AGE);
	if (!olderThan.success) return fail(ctx, "prune", `--older-than: ${olderThan.error}`);
	const { livePodsKeys, listPodsEntries, prunePods } = await import("@delacour/warden-core/pods/pods-store");
	const { color } = ctx.ui;
	const store = ctx.store();
	const dryRun = opts.dryRun === true;
	const before = listPodsEntries(store).reduce((s, e) => s + e.sizeBytes, 0);
	const removed = prunePods(store, ctx.env, {
		maxBytes: maxBytes.data,
		olderThanMs: olderThan.data,
		now: ctx.now(),
		dryRun,
		live: livePodsKeys(store, ctx.now(), deps.pidAlive),
	});
	const freed = removed.reduce((s, e) => s + e.sizeBytes, 0);
	if (!opts.json)
		heading(ctx, "pods prune", `${plural(removed.length, "entry", "entries")}${dryRun ? " · dry run" : ""}`);
	const verb = dryRun ? "would remove" : "removed";
	const text = [
		...removed.map((e) => (dryRun ? color.yellow : color.green)(`${verb} ${describeEntry(e)}`)),
		`${formatSize(before)} → ${color.bold(formatSize(before - freed))} ${color.dim(`(max ${formatSize(maxBytes.data)}, older than ${formatDuration(olderThan.data)})`)}`,
	].join("\n");
	emit(ctx, opts.json === true, { dryRun, removed, totalBytes: before, afterBytes: before - freed }, text);
	if (removed.length > 0 && !dryRun)
		warn(ctx, "sizes are apparent: worktrees cloned from an entry keep their own copy");
	return 0;
}

export function createPodsCommand(deps: PodsCommandDeps) {
	return defineCommand({
		name: "pods",
		group: "Builds",
		summary: "CocoaPods install shared across worktrees: install, list, remove, prune",
		register: (cmd, ctx, done) => {
			cmd
				.command("install")
				.description(
					"pod install through the machine-wide cache: same pods anywhere on this Mac restore in seconds (Expo: prebuild too); pass pod args after --"
				)
				.option("--project-directory <dir>", "the ios dir, relative to the project (default: ios)")
				.option("--no-cache", "run a plain pod install: don't restore from or store to the cache")
				.option("--json", "machine-readable output")
				.argument("[pod-args...]", "extra arguments for `pod install`, after --")
				.action(async (podArgs, opts) => done(await installCmd(ctx, deps, podArgs, opts)));
			cmd
				.command("ls", { isDefault: true })
				.description("list cached pods installs (the default)")
				.option("--json", "machine-readable output")
				.action(async (opts) => done(await lsCmd(ctx, opts.json === true)));
			cmd
				.command("rm")
				.alias("remove")
				.description("remove cached pods by key (or a unique prefix of at least 6 characters)")
				.argument("<key...>", "key or unique prefix, as `warden pods ls` shows it")
				.option("--dry-run", "only show what would be removed")
				.option("--json", "machine-readable output")
				.action(async (keys, opts) => done(await rmCmd(ctx, deps, keys, opts)));
			cmd
				.command("prune")
				.description(
					`remove cached pods unused for --older-than, then least-recently-used until they fit --max-size (installs in progress stay); sizes are apparent: blocks are shared with the worktrees cloned from an entry`
				)
				.option("--max-size <size>", `size limit, e.g. 10G (default: ${DEFAULT_PODS_MAX_SIZE})`)
				.option("--older-than <duration>", `unused for this long, e.g. 30d (default: ${DEFAULT_PODS_MAX_AGE})`)
				.option("--dry-run", "only show what would be removed")
				.option("--json", "machine-readable output")
				.action(async (opts) => done(await pruneCmd(ctx, deps, opts)));
		},
	});
}

export const podsCommand = createPodsCommand(defaultPodsDeps);
