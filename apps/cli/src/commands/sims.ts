import { prune } from "@delacour/warden-builds/prune";
import { SimDeleter } from "@delacour/warden-core/sims/delete";
import { SimsPruner } from "@delacour/warden-core/sims/prune";
import { type SimEntry, type SimRuleOpts, simRules } from "@delacour/warden-core/sims/rules";
import { leaseModel } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";
import { spinnerContext } from "../spinner-context";
import type { Choice } from "../ui";
import { IDLE_HELP, STALE_HELP, simsAudit } from "./sims-audit";

type Deleted = { id: string; name: string };
type Failed = Deleted & { error: string };

type DeleteOpts = { yes?: true; json?: true; dryRun?: true; suggested?: true; stale?: string; idle?: string };

/** What to delete, or the exit code to stop with (cancelled, bad udid, nothing chosen). */
type Selection = { kind: "picked"; sims: SimEntry[] } | { kind: "exit"; code: number };

export class SimsCommand extends CliCommand {
	override readonly name = "sims";
	override readonly group = "Devices";
	override readonly summary = "simulator + runtime disk audit (default), prune idle warden sims, delete (multi-select)";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		simsAudit.registerSimsAudit(cmd, ctx, done);
		cmd
			.command("delete")
			.alias("rm")
			.description("pick simulators to delete from a menu (suggestions pre-ticked) or pass udids, confirm, delete")
			.argument("[udids...]", "delete these instead of showing the menu")
			.option("--suggested", "delete every suggested sim instead of showing the menu")
			.option("--stale <duration>", STALE_HELP)
			.option("--idle <duration>", IDLE_HELP)
			.option("-y, --yes", "don't ask before deleting")
			.option("--dry-run", "only show what would be deleted")
			.option("--json", "machine-readable output")
			.action(async (udids, opts) => done(await this.deleteCmd(ctx, udids, opts)));
	}

	private fail(ctx: CommandContext, message: string): number {
		output.reportError(ctx, "sims delete", message);
		return 1;
	}

	/** Why `sim` can't be deleted (`canDelete` is false), or undefined when it can. Goldens go through `warden golden prune` (it holds the clone lock). */
	private blocker(sim: SimEntry): string | undefined {
		if (simRules.canDelete(sim)) return undefined;
		for (const b of sim.blockers) {
			if (b.kind === "leased")
				return `leased by ${leaseModel.describeOwner(b.owner)}${b.stale ? " (stale — run `warden gc`)" : ""}`;
			if (b.kind === "golden") return "golden image — use `warden golden prune`";
		}
		return "not deletable";
	}

	/** Every sim (all platforms, unavailable ones too) judged by the shared rules; suggested first, then running, then by name. */
	private async listSims(ctx: CommandContext, rules: SimRuleOpts): Promise<Result<SimEntry[]>> {
		const sims = await new SimsPruner(simsAudit.simsDeps(ctx)).judge(rules);
		if (!sims.success) return sims;
		const rank = (s: SimEntry) => (simRules.isSuggested(s) ? 0 : s.state !== "Shutdown" ? 1 : 2);
		return resultFactory.ok(sims.data.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)));
	}

	private choice(ctx: CommandContext, sim: SimEntry): Choice<string> {
		const why = this.blocker(sim);
		const tags = [
			sim.reasons.length > 0 ? simRules.describeReasons(sim.reasons) : undefined,
			sim.state !== "Shutdown" ? sim.state.toLowerCase() : undefined,
			sim.runtime,
			sim.owner === "warden" ? "warden" : undefined,
			sim.bytes > 0 ? prune.formatSize(sim.bytes) : undefined,
		];
		const hint = why ?? tags.filter((t) => t !== undefined).join(", ");
		return {
			value: sim.udid,
			label: `${sim.name} ${ctx.ui.color.dim(sim.udid)}`,
			...(hint ? { hint } : {}),
			...(why ? { disabled: true } : {}),
			...(simRules.isSuggested(sim) ? { selected: true } : {}),
		};
	}

	/** Udids given on the command line: every one must exist and be deletable, else nothing is deleted. */
	private pickByUdid(sims: SimEntry[], udids: string[]): Result<SimEntry[]> {
		const byId = new Map(sims.map((s) => [s.udid, s]));
		const picked: SimEntry[] = [];
		for (const udid of udids) {
			const sim = byId.get(udid);
			if (!sim) return resultFactory.err(`no simulator ${udid}`);
			const why = this.blocker(sim);
			if (why) return resultFactory.err(`${sim.name} (${udid}) is ${why}`);
			picked.push(sim);
		}
		return resultFactory.ok(picked);
	}

	/** The shared core delete path; a sim leased since the menu is reported as failed. */
	private async deleteAll(ctx: CommandContext, sims: SimEntry[]): Promise<{ deleted: Deleted[]; failed: Failed[] }> {
		const result = await new SimDeleter(simsAudit.simsDeps(ctx)).run(sims, { label: "sims delete" });
		return {
			deleted: result.removed.map((s) => ({ id: s.udid, name: s.name })),
			failed: [
				...result.skipped.map(({ entry, heldBy }) => ({
					id: entry.udid,
					name: entry.name,
					error: `leased by ${leaseModel.describeOwner(heldBy)}`,
				})),
				...result.failed.map(({ entry, error }) => ({ id: entry.udid, name: entry.name, error })),
			],
		};
	}

	private async selectSims(
		ctx: CommandContext,
		sims: SimEntry[],
		udids: string[],
		opts: DeleteOpts
	): Promise<Selection> {
		const { ui } = ctx;
		if (opts.suggested) {
			const picked = sims.filter(simRules.isSuggested);
			if (picked.length > 0) return { kind: "picked", sims: picked };
			output.note(ctx, "no suggested simulators");
			return { kind: "exit", code: 0 };
		}
		if (udids.length > 0) {
			const byUdid = this.pickByUdid(sims, udids);
			return byUdid.success
				? { kind: "picked", sims: byUdid.data }
				: { kind: "exit", code: this.fail(ctx, byUdid.error) };
		}
		const answer = await ui.multiselect(
			"Select simulators to delete",
			sims.map((s) => this.choice(ctx, s))
		);
		if (answer === undefined) {
			ui.cancelled("Aborted.");
			return { kind: "exit", code: 1 };
		}
		const chosen = new Set(answer);
		const picked = sims.filter((s) => chosen.has(s.udid));
		if (picked.length > 0) return { kind: "picked", sims: picked };
		output.note(ctx, "nothing selected");
		return { kind: "exit", code: 0 };
	}

	private async confirmDelete(ctx: CommandContext, picked: SimEntry[]): Promise<boolean> {
		const { ui } = ctx;
		for (const s of picked) {
			const why = s.reasons.length > 0 ? ui.color.dim(` — ${simRules.describeReasons(s.reasons)}`) : "";
			ctx.err(`${ui.color.yellow(`will delete ${s.name} (${s.udid})`)}${why}`);
		}
		if ((await ui.confirm(`Delete ${picked.length} simulator(s)? This can't be undone.`)) === true) return true;
		ui.cancelled("Aborted.");
		return false;
	}

	private dryRun(ctx: CommandContext, picked: SimEntry[], json: boolean): number {
		const { color } = ctx.ui;
		const text = picked
			.map((s) => {
				const why = s.reasons.length > 0 ? color.dim(` — ${simRules.describeReasons(s.reasons)}`) : "";
				return `${color.yellow(`would delete ${s.name} (${s.udid})`)}${why}`;
			})
			.join("\n");
		const wouldDelete = picked.map((s) => ({ id: s.udid, name: s.name, reasons: s.reasons }));
		output.emit(ctx, json, { dryRun: true, wouldDelete }, text);
		return 0;
	}

	/** Flag combinations that can't work, checked before touching simctl. */
	private usageError(ctx: CommandContext, udids: string[], opts: DeleteOpts): string | undefined {
		const { interactive } = ctx.ui;
		if (opts.suggested && udids.length > 0) return "pass udids or --suggested, not both";
		if (udids.length === 0 && !opts.suggested && !interactive)
			return "not a terminal — pass udids or --suggested (see `warden devices ios`)";
		if (!interactive && !opts.yes && !opts.dryRun) return "not a terminal — pass --yes to delete";
		return undefined;
	}

	/**
	 * Permanently delete simulators — picked from a multi-select menu, given as udids, or every
	 * suggestion (`--suggested`). The shared rules (`sims/rules.ts`, same as `audit`/`prune`) decide
	 * what's suggested and start it ticked; leased sims and goldens are listed but can't be picked.
	 * Asks before deleting unless `--yes`. Deletes go through the shared `SimDeleter` (leased to us
	 * while they go), so a racing claim either wins (sim skipped) or waits it out.
	 */
	private async deleteCmd(ctx: CommandContext, udids: string[], opts: DeleteOpts): Promise<number> {
		const { color } = ctx.ui;
		const usage = this.usageError(ctx, udids, opts);
		if (usage) return this.fail(ctx, usage);
		const rules = simsAudit.parseRuleOpts(opts);
		if (!rules.success) return this.fail(ctx, rules.error);
		const sims = await this.listSims(ctx, rules.data);
		if (!sims.success) return this.fail(ctx, sims.error);
		if (sims.data.length === 0) {
			output.note(ctx, "no simulators");
			return 0;
		}
		const selection = await this.selectSims(ctx, sims.data, udids, opts);
		if (selection.kind === "exit") return selection.code;
		const picked = selection.sims;
		if (!opts.json)
			output.heading(
				ctx,
				"sims delete",
				`${output.plural(picked.length, "simulator")}${opts.dryRun ? " · dry run" : ""}`
			);
		if (opts.dryRun) return this.dryRun(ctx, picked, opts.json === true);
		if (!opts.yes && !(await this.confirmDelete(ctx, picked))) return 1;

		const result = await spinnerContext.withSpinner(ctx, `deleting ${picked.length} simulator(s)…`, (sctx) =>
			this.deleteAll(sctx, picked)
		);
		for (const f of result.failed) output.reportError(ctx, "sims delete", `skipped ${f.name} (${f.id}): ${f.error}`);
		const text = result.deleted.map((d) => color.green(`deleted ${d.name} (${d.id})`)).join("\n");
		if (opts.json || text) output.emit(ctx, opts.json === true, result, text);
		return result.failed.length > 0 ? 1 : 0;
	}
}

export const simsCommand = new SimsCommand().definition();
