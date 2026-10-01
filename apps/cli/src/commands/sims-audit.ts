import { formatSize, parseSize } from "@delacour/warden-core/builds/prune";
import { formatDuration, parseDuration } from "@delacour/warden-core/duration";
import { processAlive } from "@delacour/warden-core/liveness";
import type { SimAudit, SimAuditEntry, SimOwner, SimVerdict } from "@delacour/warden-core/sims/audit";
import {
	auditMachineSims,
	pruneSims,
	type SimsAuditOpts,
	type SimsDeps,
	type SimsPruneResult,
} from "@delacour/warden-core/sims/prune";
import { DEFAULT_SIM_IDLE_MS } from "@delacour/warden-core/sims/sims.defaults";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { ChalkInstance } from "chalk";
import { resolveOwner } from "../claim-flags";
import type { Register } from "../command";
import type { CommandContext } from "../context";
import { emit, formatTable } from "../output";
import { withSpinner } from "../spinner-context";

type OwnerFilter = SimOwner | "all";
type CommonOpts = { idle?: string; maxSize?: string; json?: true };
type AuditOpts = CommonOpts & { owner?: string };
type PruneOpts = CommonOpts & { dryRun?: true; yes?: true };

function fail(ctx: CommandContext, sub: string, message: string): number {
	ctx.err(ctx.ui.color.red(`warden sims ${sub}: ${message}`));
	return 1;
}

function parseOpts(opts: CommonOpts): Result<SimsAuditOpts> {
	const idle = opts.idle === undefined ? ok(DEFAULT_SIM_IDLE_MS) : parseDuration(opts.idle);
	if (!idle.success) return idle;
	if (opts.maxSize === undefined) return ok({ idleMs: idle.data });
	const max = parseSize(opts.maxSize);
	return max.success ? ok({ idleMs: idle.data, maxBytes: max.data }) : max;
}

function parseOwner(raw: string | undefined): Result<OwnerFilter> {
	const value = raw ?? "all";
	return value === "all" || value === "warden" || value === "golden" || value === "foreign"
		? ok(value)
		: err(`invalid --owner "${value}" (warden | golden | foreign | all)`);
}

function simsDeps(ctx: CommandContext): SimsDeps {
	return {
		exec: ctx.exec,
		store: ctx.store(),
		owner: resolveOwner(ctx),
		pid: process.pid,
		now: ctx.now,
		pidAlive: processAlive,
	};
}

function describeVerdict(verdict: SimVerdict, color: ChalkInstance): string {
	switch (verdict.kind) {
		case "keep":
			return color.dim(`keep (${verdict.reason})`);
		case "delete":
			return color.yellow(`delete (${verdict.reason})`);
		case "foreign":
			return verdict.hint ? color.cyan(`foreign (${verdict.hint})`) : color.dim("foreign");
	}
}

function lastUsed(entry: SimAuditEntry, now: number): string {
	return entry.lastUsedAt === undefined ? "never" : `${formatDuration(Math.max(0, now - entry.lastUsedAt))} ago`;
}

function auditText(ctx: CommandContext, audit: SimAudit, entries: readonly SimAuditEntry[]): string {
	const { color } = ctx.ui;
	const now = ctx.now();
	if (entries.length === 0) return color.dim("no simulators");
	const rows = entries.map((e) => [
		color.bold(e.name),
		color.dim(e.udid),
		e.isAvailable ? e.runtime : color.red(`${e.runtime} (unavailable)`),
		e.state,
		e.owner,
		e.leased ? color.green("yes") : "",
		lastUsed(e, now),
		formatSize(e.bytes),
		describeVerdict(e.verdict, color),
	]);
	const lines = [
		formatTable(["NAME", "UDID", "RUNTIME", "STATE", "OWNER", "LEASED", "LAST USED", "SIZE", "VERDICT"], rows, color),
		"",
		`total ${color.bold(formatSize(audit.totalBytes))} across ${audit.entries.length} sim(s)`,
	];
	if (audit.reclaimableBytes > 0)
		lines.push(color.yellow(`warden can free ${formatSize(audit.reclaimableBytes)} → run \`warden sims prune\``));
	if (audit.foreignReclaimableBytes > 0)
		lines.push(
			color.cyan(
				`${formatSize(audit.foreignReclaimableBytes)} in foreign sims warden won't touch — review, then \`xcrun simctl delete unavailable\` or \`xcrun simctl delete <udid>\``
			)
		);
	if (audit.maxBytes !== undefined)
		lines.push(
			audit.overBudget
				? color.red(`over budget: ${formatSize(audit.afterBytes)} after pruning > max ${formatSize(audit.maxBytes)}`)
				: color.dim(`within budget: ${formatSize(audit.afterBytes)} after pruning ≤ max ${formatSize(audit.maxBytes)}`)
		);
	return lines.join("\n");
}

/** Read-only: every sim on the machine with size, owner, lease, last use and what may be deleted. */
async function auditCmd(ctx: CommandContext, opts: AuditOpts): Promise<number> {
	const parsed = parseOpts(opts);
	if (!parsed.success) return fail(ctx, "audit", parsed.error);
	const owner = parseOwner(opts.owner);
	if (!owner.success) return fail(ctx, "audit", owner.error);
	const audit = await withSpinner(ctx, "auditing simulators…", (sctx) => auditMachineSims(simsDeps(sctx), parsed.data));
	if (!audit.success) return fail(ctx, "audit", audit.error);
	const entries = audit.data.entries.filter((e) => owner.data === "all" || e.owner === owner.data);
	emit(ctx, opts.json === true, { ...audit.data, entries }, auditText(ctx, audit.data, entries));
	return 0;
}

const describeSim = (e: SimAuditEntry) =>
	`${e.name} ${e.udid} (${formatSize(e.bytes)}, ${e.verdict.kind === "delete" ? e.verdict.reason : ""})`;

/** Terminal confirm of the preview's deletes; true = go ahead. */
async function confirmDeletes(ctx: CommandContext, preview: SimsPruneResult): Promise<boolean> {
	const { ui } = ctx;
	for (const e of preview.removed) ctx.err(ui.color.yellow(`will delete ${describeSim(e)}`));
	const answer = await ui.confirm(`Delete ${preview.removed.length} simulator(s) (${formatSize(preview.freedBytes)})?`);
	if (answer === true) return true;
	ui.cancelled("Aborted.");
	return false;
}

function pruneText(ctx: CommandContext, result: SimsPruneResult): string {
	const { color } = ctx.ui;
	const { dryRun, removed, skipped, failed, freedBytes } = result;
	const verb = dryRun ? "would delete" : "deleted";
	return [
		...removed.map((e) => (dryRun ? color.yellow : color.green)(`${verb} ${describeSim(e)}`)),
		...skipped.map((e) => color.dim(`skipped ${e.name} ${e.udid} (leased since the audit)`)),
		...failed.map((f) => color.red(`failed ${f.entry.name} ${f.entry.udid}: ${f.error}`)),
		removed.length === 0
			? color.dim("nothing to delete")
			: `${dryRun ? "would free" : "freed"} ${color.bold(formatSize(freedBytes))}`,
	].join("\n");
}

/**
 * Delete the warden-created sims the audit marks `delete`. Destructive, so without `--dry-run` it
 * needs `--yes` or a terminal confirm. Foreign sims and goldens are never deleted.
 */
async function pruneCmd(ctx: CommandContext, opts: PruneOpts): Promise<number> {
	const parsed = parseOpts(opts);
	if (!parsed.success) return fail(ctx, "prune", parsed.error);
	const dryRun = opts.dryRun === true;
	const ask = !dryRun && !opts.yes;
	if (ask && !ctx.ui.interactive) return fail(ctx, "prune", "refusing to delete without --yes (or --dry-run)");
	const deps = simsDeps(ctx);
	const preview = await withSpinner(ctx, "auditing simulators…", () =>
		pruneSims(deps, { ...parsed.data, dryRun: true })
	);
	if (!preview.success) return fail(ctx, "prune", preview.error);
	const nothing = preview.data.removed.length === 0;
	if (ask && !nothing && !(await confirmDeletes(ctx, preview.data))) return 1;
	const result =
		dryRun || nothing
			? preview
			: await withSpinner(ctx, `deleting ${preview.data.removed.length} simulator(s)…`, () =>
					pruneSims(deps, { ...parsed.data, dryRun: false })
				);
	if (!result.success) return fail(ctx, "prune", result.error);
	const { removed, skipped, failed, freedBytes, audit } = result.data;
	emit(
		ctx,
		opts.json === true,
		{ dryRun, removed, skipped, failed, freedBytes, totalBytes: audit.totalBytes },
		pruneText(ctx, result.data)
	);
	return failed.length > 0 ? 1 : 0;
}

/** `warden sims audit` (the default) and `warden sims prune`: disk usage and LRU/idle cleanup of warden sims. */
export const registerSimsAudit: Register = (cmd, ctx, done) => {
	const idleHelp = `warden sims unused this long are deletable (default ${formatDuration(DEFAULT_SIM_IDLE_MS)})`;
	cmd
		.command("audit", { isDefault: true })
		.description("every sim on the machine: size, owner, lease, last use, verdict (the default; read-only)")
		.option("--idle <duration>", idleHelp)
		.option("--max-size <size>", "disk budget for all sims, e.g. 40G — LRU warden sims over it are deletable")
		.option("--owner <owner>", "warden | golden | foreign | all (default all)")
		.option("--json", "machine-readable output")
		.action(async (opts) => done(await auditCmd(ctx, opts)));
	cmd
		.command("prune")
		.description("delete warden sims the audit marks deletable (never foreign sims or goldens)")
		.option("--idle <duration>", idleHelp)
		.option("--max-size <size>", "also delete least-recently-used warden sims until all sims fit, e.g. 40G")
		.option("--dry-run", "only show what would be deleted")
		.option("--yes", "don't ask before deleting")
		.option("--json", "machine-readable output")
		.action(async (opts) => done(await pruneCmd(ctx, opts)));
};
