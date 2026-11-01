import { prune } from "@delacour/warden-builds/prune";
import { durationParser } from "@delacour/warden-config/duration";
import type { SimAudit } from "@delacour/warden-core/sims/audit";
import { type SimsDeps, type SimsPruneResult, SimsPruner } from "@delacour/warden-core/sims/prune";
import { type SimEntry, type SimOwner, type SimRuleOpts, simRules } from "@delacour/warden-core/sims/rules";
import {
	DiskRuntimeLister,
	type RuntimeAudit,
	type RuntimeVerdict,
	runtimeAuditor,
} from "@delacour/warden-core/sims/runtimes";
import { DEFAULT_SIM_IDLE_MS, DEFAULT_SIM_STALE_MS } from "@delacour/warden-core/sims/sims.defaults";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { liveness } from "@delacour/warden-store/liveness";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { ChalkInstance } from "chalk";
import type { Register } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";
import { spinnerContext } from "../spinner-context";

type OwnerFilter = SimOwner | "all";
type CommonOpts = { idle?: string; maxSize?: string; json?: true };
type AuditOpts = CommonOpts & { owner?: string; stale?: string };
type PruneOpts = CommonOpts & { dryRun?: true; yes?: true };

export const IDLE_HELP = `warden sims unused this long are deletable (default ${simRules.formatAge(DEFAULT_SIM_IDLE_MS)})`;
export const STALE_HELP = `foreign sims not booted this long are suggested (default ${simRules.formatAge(DEFAULT_SIM_STALE_MS)})`;

type RuntimeSection = { kind: "ok"; audit: RuntimeAudit } | { kind: "error"; error: string };

export class SimsAudit {
	private fail(ctx: CommandContext, sub: string, message: string): number {
		output.reportError(ctx, `sims ${sub}`, message);
		return 1;
	}

	private parseFlag(flag: string, raw: string | undefined, fallback: number): Result<number> {
		if (raw === undefined) return resultFactory.ok(fallback);
		const parsed = durationParser.parse(raw);
		return parsed.success ? parsed : resultFactory.err(`${flag}: ${parsed.error}`);
	}

	/** `--idle` / `--stale` / `--max-size` → the rule thresholds every `warden sims` subcommand shares. */
	parseRuleOpts(opts: { idle?: string; stale?: string; maxSize?: string }): Result<SimRuleOpts> {
		const idle = this.parseFlag("--idle", opts.idle, DEFAULT_SIM_IDLE_MS);
		if (!idle.success) return idle;
		const stale = this.parseFlag("--stale", opts.stale, DEFAULT_SIM_STALE_MS);
		if (!stale.success) return stale;
		const thresholds = { idleMs: idle.data, staleMs: stale.data };
		if (opts.maxSize === undefined) return resultFactory.ok(thresholds);
		const max = prune.parseSize(opts.maxSize);
		return max.success
			? resultFactory.ok({ ...thresholds, maxBytes: max.data })
			: resultFactory.err(`--max-size: ${max.error}`);
	}

	private parseOwner(raw: string | undefined): Result<OwnerFilter> {
		const value = raw ?? "all";
		return value === "all" || value === "warden" || value === "golden" || value === "foreign"
			? resultFactory.ok(value)
			: resultFactory.err(`invalid --owner "${value}" (warden | golden | foreign | all)`);
	}

	simsDeps(ctx: CommandContext): SimsDeps {
		return {
			exec: ctx.exec,
			store: ctx.store(),
			owner: ownerResolver.resolve(ctx),
			pid: process.pid,
			now: ctx.now,
			pidAlive: liveness.processAlive,
		};
	}

	/** `delete: warden sim unused 30d` — the same reason text as the `sims delete` menu. */
	private describeVerdict(entry: SimEntry, color: ChalkInstance): string {
		const { verdict } = entry;
		switch (verdict.kind) {
			case "keep":
				return color.dim(`keep (${verdict.reason})`);
			case "delete":
				return color.yellow(`delete: ${simRules.describeReasons(entry.reasons)}`);
			case "foreign":
				return verdict.hint ? color.cyan(`foreign: ${simRules.describeReasons(entry.reasons)}`) : color.dim("foreign");
		}
	}

	private lastUsed(entry: SimEntry, now: number): string {
		return entry.lastUsedAt === undefined
			? "never"
			: `${durationParser.format(Math.max(0, now - entry.lastUsedAt))} ago`;
	}

	private auditText(ctx: CommandContext, audit: SimAudit, entries: readonly SimEntry[]): string {
		const { color } = ctx.ui;
		const now = ctx.now();
		if (entries.length === 0) return color.dim("no simulators");
		const rows = entries.map((e) => [
			color.bold(e.name),
			color.dim(e.udid),
			e.isAvailable ? e.runtime : color.red(`${e.runtime} (unavailable)`),
			e.leased ? color.cyan("leased") : e.state === "Booted" ? color.green(e.state) : color.dim(e.state),
			e.owner,
			this.lastUsed(e, now),
			prune.formatSize(e.bytes),
			this.describeVerdict(e, color),
		]);
		const lines = [
			output.table(ctx, ["NAME", "UDID", "RUNTIME", "STATE", "OWNER", "LAST USED", "SIZE", "VERDICT"], rows, [
				{ column: 0, min: 18 },
				{ column: 1, min: 9 },
			]),
			"",
			`total ${color.bold(prune.formatSize(audit.totalBytes))} across ${audit.entries.length} sim(s)`,
		];
		if (audit.reclaimableBytes > 0)
			lines.push(
				color.yellow(`warden can free ${prune.formatSize(audit.reclaimableBytes)} → run \`warden sims prune\``)
			);
		if (audit.foreignReclaimableBytes > 0)
			lines.push(
				color.cyan(
					`${prune.formatSize(audit.foreignReclaimableBytes)} in foreign sims prune won't touch — review, then \`warden sims delete\` (they're pre-ticked)`
				)
			);
		if (audit.maxBytes !== undefined)
			lines.push(
				audit.overBudget
					? color.red(
							`over budget: ${prune.formatSize(audit.afterBytes)} after pruning > max ${prune.formatSize(audit.maxBytes)}`
						)
					: color.dim(
							`within budget: ${prune.formatSize(audit.afterBytes)} after pruning ≤ max ${prune.formatSize(audit.maxBytes)}`
						)
			);
		return lines.join("\n");
	}

	private describeRuntimeVerdict(verdict: RuntimeVerdict, color: ChalkInstance): string {
		switch (verdict.kind) {
			case "in-use":
				return color.dim("in use");
			case "unused-after-prune":
				return color.yellow("unused after prune");
			case "unused":
				return color.cyan("unused");
			case "protected":
				return color.dim("unused (not deletable)");
		}
	}

	private runtimesText(ctx: CommandContext, section: RuntimeSection): string {
		const { color } = ctx.ui;
		if (section.kind === "error") return color.yellow(`runtimes: skipped (${section.error})`);
		const { audit } = section;
		if (audit.entries.length === 0) return color.dim("no downloaded runtimes");
		const now = ctx.now();
		const rows = audit.entries.map((r) => [
			color.bold(r.runtime),
			r.build,
			color.dim(r.identifier),
			String(r.sims),
			r.lastUsedAt === undefined ? "never" : `${durationParser.format(Math.max(0, now - r.lastUsedAt))} ago`,
			prune.formatSize(r.sizeBytes),
			this.describeRuntimeVerdict(r.verdict, color),
		]);
		const lines = [
			output.table(ctx, ["RUNTIME", "BUILD", "IDENTIFIER", "SIMS", "LAST USED", "SIZE", "VERDICT"], rows, {
				column: 2,
				keep: "end",
				min: 16,
			}),
			"",
			`runtimes ${color.bold(prune.formatSize(audit.totalBytes))} across ${audit.entries.length} runtime(s)`,
		];
		if (audit.unusedBytes > 0)
			lines.push(
				color.cyan(
					`${prune.formatSize(audit.unusedBytes)} in unused runtimes — machine-wide, warden won't touch them: \`xcrun simctl runtime delete <identifier>\``
				)
			);
		if (audit.unusedAfterPruneBytes > audit.unusedBytes)
			lines.push(
				color.yellow(
					`${prune.formatSize(audit.unusedAfterPruneBytes - audit.unusedBytes)} more becomes unused after \`warden sims prune\``
				)
			);
		return lines.join("\n");
	}

	/** Runtime half of the audit; a host without `simctl runtime` (Xcode < 15) just gets a note. */
	private async runtimeSection(ctx: CommandContext, sims: SimAudit): Promise<RuntimeSection> {
		const runtimes = await new DiskRuntimeLister(ctx.exec).list();
		return runtimes.success
			? { kind: "ok", audit: runtimeAuditor.audit(runtimes.data, sims.entries) }
			: { kind: "error", error: runtimes.error };
	}

	/**
	 * Read-only: every sim on the machine with size, owner, lease, last use and what may be deleted,
	 * then every downloaded runtime with its size and how many sims use it.
	 */
	private async auditCmd(ctx: CommandContext, opts: AuditOpts): Promise<number> {
		const parsed = this.parseRuleOpts(opts);
		if (!parsed.success) return this.fail(ctx, "audit", parsed.error);
		const owner = this.parseOwner(opts.owner);
		if (!owner.success) return this.fail(ctx, "audit", owner.error);
		if (!opts.json)
			output.heading(ctx, "sims audit", opts.owner && opts.owner !== "all" ? `owner ${opts.owner}` : undefined);
		const audit = await spinnerContext.withSpinner(ctx, "auditing simulators…", (sctx) =>
			new SimsPruner(this.simsDeps(sctx)).audit(parsed.data)
		);
		if (!audit.success) return this.fail(ctx, "audit", audit.error);
		const runtimes = await this.runtimeSection(ctx, audit.data);
		const entries = audit.data.entries.filter((e) => owner.data === "all" || e.owner === owner.data);
		const json = {
			...audit.data,
			entries,
			runtimes: runtimes.kind === "ok" ? runtimes.audit : null,
			...(runtimes.kind === "error" ? { runtimesError: runtimes.error } : {}),
		};
		output.emit(
			ctx,
			opts.json === true,
			json,
			`${this.auditText(ctx, audit.data, entries)}\n\n${this.runtimesText(ctx, runtimes)}`
		);
		return 0;
	}

	private describeSim(e: SimEntry) {
		return `${e.name} ${e.udid} (${prune.formatSize(e.bytes)}, ${simRules.describeReasons(e.reasons)})`;
	}

	/** Terminal confirm of the preview's deletes; true = go ahead. */
	private async confirmDeletes(ctx: CommandContext, preview: SimsPruneResult): Promise<boolean> {
		const { ui } = ctx;
		for (const e of preview.removed) output.warn(ctx, `will delete ${this.describeSim(e)}`);
		const answer = await ui.confirm(
			`Delete ${preview.removed.length} simulator(s) (${prune.formatSize(preview.freedBytes)})?`
		);
		if (answer === true) return true;
		ui.cancelled("Aborted.");
		return false;
	}

	private pruneText(ctx: CommandContext, result: SimsPruneResult): string {
		const { color } = ctx.ui;
		const { dryRun, removed, skipped, failed, freedBytes } = result;
		const verb = dryRun ? "would delete" : "deleted";
		return [
			...removed.map((e) => (dryRun ? color.yellow : color.green)(`${verb} ${this.describeSim(e)}`)),
			...skipped.map((e) => color.dim(`skipped ${e.name} ${e.udid} (leased since the audit)`)),
			...failed.map((f) => color.red(`failed ${f.entry.name} ${f.entry.udid}: ${f.error}`)),
			removed.length === 0
				? color.dim("nothing to delete")
				: `${dryRun ? "would free" : "freed"} ${color.bold(prune.formatSize(freedBytes))}`,
		].join("\n");
	}

	/**
	 * Delete the warden-created sims the audit marks `delete`. Destructive, so without `--dry-run` it
	 * needs `--yes` or a terminal confirm. Foreign sims and goldens are never deleted.
	 */
	private async pruneCmd(ctx: CommandContext, opts: PruneOpts): Promise<number> {
		const parsed = this.parseRuleOpts(opts);
		if (!parsed.success) return this.fail(ctx, "prune", parsed.error);
		const dryRun = opts.dryRun === true;
		const ask = !dryRun && !opts.yes;
		if (ask && !ctx.ui.interactive) return this.fail(ctx, "prune", "refusing to delete without --yes (or --dry-run)");
		if (!opts.json) output.heading(ctx, "sims prune", dryRun ? "dry run" : undefined);
		const deps = this.simsDeps(ctx);
		const preview = await spinnerContext.withSpinner(ctx, "auditing simulators…", () =>
			new SimsPruner(deps).prune({ ...parsed.data, dryRun: true })
		);
		if (!preview.success) return this.fail(ctx, "prune", preview.error);
		const nothing = preview.data.removed.length === 0;
		if (ask && !nothing && !(await this.confirmDeletes(ctx, preview.data))) return 1;
		const result =
			dryRun || nothing
				? preview
				: await spinnerContext.withSpinner(ctx, `deleting ${preview.data.removed.length} simulator(s)…`, () =>
						new SimsPruner(deps).prune({ ...parsed.data, dryRun: false })
					);
		if (!result.success) return this.fail(ctx, "prune", result.error);
		const { removed, skipped, failed, freedBytes, audit } = result.data;
		output.emit(
			ctx,
			opts.json === true,
			{ dryRun, removed, skipped, failed, freedBytes, totalBytes: audit.totalBytes },
			this.pruneText(ctx, result.data)
		);
		return failed.length > 0 ? 1 : 0;
	}

	/** `warden sims audit` (the default) and `warden sims prune`: disk usage and LRU/idle cleanup of warden sims. */
	readonly registerSimsAudit: Register = (cmd, ctx, done) => {
		cmd
			.command("audit", { isDefault: true })
			.description("every sim + downloaded runtime: size, owner, lease, last use, verdict (the default; read-only)")
			.option("--idle <duration>", IDLE_HELP)
			.option("--stale <duration>", STALE_HELP)
			.option("--max-size <size>", "disk budget for all sims, e.g. 40G — LRU warden sims over it are deletable")
			.option("--owner <owner>", "warden | golden | foreign | all (default all)")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await this.auditCmd(ctx, opts)));
		cmd
			.command("prune")
			.description("delete warden sims the audit marks deletable (never foreign sims or goldens)")
			.option("--idle <duration>", IDLE_HELP)
			.option("--max-size <size>", "also delete least-recently-used warden sims until all sims fit, e.g. 40G")
			.option("--dry-run", "only show what would be deleted")
			.option("--yes", "don't ask before deleting")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await this.pruneCmd(ctx, opts)));
	};
}

export const simsAudit = new SimsAudit();
