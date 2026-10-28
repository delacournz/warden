import { formatSize } from "@delacour/warden-core/builds/prune";
import { parseDuration } from "@delacour/warden-core/duration";
import { processAlive } from "@delacour/warden-core/liveness";
import {
	auditWorktrees,
	removeWorktrees,
	summarizeWorktreeStates,
	WORKTREE_STATES,
	type WorktreeAudit,
	type WorktreeDeps,
	type WorktreeRemoval,
	type WorktreeState,
	type WorktreeStateName,
	type WorktreeSummary,
} from "@delacour/warden-core/worktrees/audit";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { ChalkInstance } from "chalk";
import { mapBounded } from "../bounded";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, heading, plural, reportError, table } from "../output";
import { withSpinner } from "../spinner-context";

const DEFAULT_IDLE_MS = 3 * 86_400_000;
const SIZE_CONCURRENCY = 4;
const AUDIT_CONCURRENCY = 4;

type Opts = { root: string[]; idle?: string; apply?: true; fetch: boolean; size: boolean; json?: true };

export function worktreeDeps(ctx: CommandContext): WorktreeDeps {
	const store = ctx.store();
	return {
		exec: ctx.exec,
		now: ctx.now(),
		pidAlive: processAlive,
		leases: store.listLeases(),
		cwd: ctx.cwd,
		git: ctx.git,
		map: (items, fn) => mapBounded(items, AUDIT_CONCURRENCY, fn),
		deleteLeases: (ids) => store.deleteLeases(ids),
	};
}

/** `du -sk` of every dir that exists, a few at a time; a worktree du cannot read stays unsized. */
async function sizeEntries(ctx: CommandContext, entries: readonly WorktreeState[]): Promise<WorktreeState[]> {
	return mapBounded(entries, SIZE_CONCURRENCY, async (entry) => {
		if (entry.state === "stale-ref") return entry;
		const res = await ctx.exec(["du", "-sk", entry.path]);
		const kb = Number(res.stdout.trim().split(/\s+/)[0]);
		return res.exitCode === 0 && Number.isFinite(kb) ? { ...entry, bytes: kb * 1024 } : entry;
	});
}

function byState(a: WorktreeState, b: WorktreeState): number {
	return WORKTREE_STATES.indexOf(a.state) - WORKTREE_STATES.indexOf(b.state) || a.path.localeCompare(b.path);
}

export type WorktreeSummaryOpts = { roots?: readonly string[]; idleMs?: number; size?: boolean };

/**
 * Cheap counts for `warden disk`: no fetch, only the `merged` worktrees are sized (unless `size: false`).
 * Merge evidence comes from what is already local (plus `gh` when the branch is not an ancestor).
 */
export async function summarizeWorktrees(
	ctx: CommandContext,
	opts: WorktreeSummaryOpts = {}
): Promise<{ summary: WorktreeSummary; audit: WorktreeAudit }> {
	const audit = await auditWorktrees(worktreeDeps(ctx), {
		roots: opts.roots ?? [],
		idleMs: opts.idleMs ?? DEFAULT_IDLE_MS,
		fetch: false,
	});
	if (opts.size !== false) {
		const sized = await sizeEntries(
			ctx,
			audit.entries.filter((e) => e.state === "merged")
		);
		const bySize = new Map(sized.map((e) => [e.path, e]));
		audit.entries = audit.entries.map((e) => bySize.get(e.path) ?? e);
	}
	return { summary: summarizeWorktreeStates(audit.entries), audit };
}

const PAINT: Record<WorktreeStateName, (color: ChalkInstance) => ChalkInstance> = {
	merged: (c) => c.green,
	review: (c) => c.yellow,
	unmerged: (c) => c.cyan,
	active: (c) => c.blue,
	"in-use": (c) => c.magenta,
	locked: (c) => c.dim,
	"stale-ref": (c) => c.dim,
};

function totalsText(ctx: CommandContext, summary: WorktreeSummary): string {
	const { color } = ctx.ui;
	const parts = WORKTREE_STATES.filter((s) => summary.byState[s] > 0).map((s) => `${summary.byState[s]} ${s}`);
	const lines = [
		`${plural(summary.total, "worktree")}: ${parts.join(", ")}${summary.bytes > 0 ? ` (${formatSize(summary.bytes)})` : ""}`,
	];
	if (summary.removable > 0) {
		const size = summary.removableBytes > 0 ? ` and free ${formatSize(summary.removableBytes)}` : "";
		lines.push(color.yellow(`\`warden worktrees --apply\` removes ${summary.removable} merged${size}`));
	}
	return lines.join("\n");
}

function auditText(ctx: CommandContext, entries: readonly WorktreeState[], summary: WorktreeSummary): string {
	const { color } = ctx.ui;
	if (entries.length === 0) return color.dim("no worktrees besides the main checkouts");
	const rows = entries.map((e) => [
		PAINT[e.state](color)(e.state),
		e.bytes === undefined ? "" : formatSize(e.bytes),
		e.branch === "" ? color.dim("(detached)") : e.branch,
		e.path,
		color.dim(e.evidence),
	]);
	return `${table(ctx, ["STATE", "SIZE", "BRANCH", "PATH", "EVIDENCE"], rows, { column: 3, keep: "end", min: 20 })}\n\n${totalsText(ctx, summary)}`;
}

function resultsText(ctx: CommandContext, results: readonly WorktreeRemoval[]): string {
	const { color } = ctx.ui;
	const paint = {
		removed: color.green,
		pruned: color.green,
		refused: color.red,
		failed: color.red,
		skipped: color.dim,
	};
	const acted = results.filter((r) => r.outcome !== "skipped");
	if (acted.length === 0) return color.dim("nothing to remove");
	const freed = results.reduce((n, r) => n + (r.outcome === "removed" ? (r.entry.bytes ?? 0) : 0), 0);
	return [
		...acted.map((r) => paint[r.outcome](`${r.outcome} ${r.entry.path}: ${r.detail}`)),
		...(freed > 0 ? [`freed ${color.bold(formatSize(freed))}`] : []),
	].join("\n");
}

function parseIdle(raw: string | undefined): Result<number> {
	if (raw === undefined) return ok(DEFAULT_IDLE_MS);
	const parsed = parseDuration(raw);
	return parsed.success ? parsed : err(`--idle: ${parsed.error}`);
}

/**
 * Audit every linked git worktree warden can see (cwd repo, repos of lease owners, `--root`s). Read-only
 * unless `--apply`, which removes only clean merged worktrees and prunes dir-less refs.
 */
async function worktrees(ctx: CommandContext, opts: Opts): Promise<number> {
	const idle = parseIdle(opts.idle);
	if (!idle.success) {
		reportError(ctx, "worktrees", idle.error);
		return 1;
	}
	const json = opts.json === true;
	if (!json) heading(ctx, "worktrees", opts.apply ? "apply" : "dry run");
	const deps = worktreeDeps(ctx);
	const found = await withSpinner(ctx, "auditing worktrees…", async (sctx) => {
		const audit = await auditWorktrees(
			{ ...deps, exec: sctx.exec },
			{ roots: opts.root, idleMs: idle.data, fetch: opts.fetch }
		);
		const entries = (opts.size ? await sizeEntries(sctx, audit.entries) : audit.entries).sort(byState);
		return { ...audit, entries };
	});
	const summary = summarizeWorktreeStates(found.entries);
	const results = opts.apply ? await removeWorktrees(found.entries, deps) : undefined;
	const text = results ? resultsText(ctx, results) : auditText(ctx, found.entries, summary);
	emit(
		ctx,
		json,
		{ dryRun: !opts.apply, ...found, summary, ...(results ? { results } : {}) },
		[text, ...found.notes.map((n) => ctx.ui.color.dim(n))].join("\n")
	);
	return results?.some((r) => r.outcome === "failed" || r.outcome === "refused") ? 1 : 0;
}

const collect = (value: string, prev: string[]): string[] => [...prev, value];

export const worktreesCommand = defineCommand({
	name: "worktrees",
	group: "Devices",
	summary: "audit git worktrees agents left behind; --apply removes the clean merged ones",
	register: (cmd, ctx, done) => {
		cmd
			.option("--root <dir>", "also audit this repo, or the repos directly under this folder (repeatable)", collect, [])
			.option("--idle <duration>", "files changed within this make a worktree active (default 3d; 0 turns it off)")
			.option("--apply", "remove merged worktrees (git worktree remove, no --force) and prune dir-less refs")
			.option("--no-fetch", "skip git fetch before the merge checks")
			.option("--no-size", "skip sizing each worktree (du)")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await worktrees(ctx, opts)));
	},
});
