import { formatSize } from "@delacour/warden-core/builds/prune";
import { deleteSims } from "@delacour/warden-core/sims/delete";
import { judgeMachineSims } from "@delacour/warden-core/sims/prune";
import {
	canDelete,
	describeReasons,
	isSuggested,
	type SimEntry,
	type SimRuleOpts,
} from "@delacour/warden-core/sims/rules";
import { describeOwner } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";
import type { Choice } from "../ui";
import { IDLE_HELP, parseRuleOpts, registerSimsAudit, STALE_HELP, simsDeps } from "./sims-audit";

type Deleted = { id: string; name: string };
type Failed = Deleted & { error: string };

function fail(ctx: CommandContext, message: string): number {
	ctx.err(ctx.ui.color.red(`warden sims delete: ${message}`));
	return 1;
}

/** Why `sim` can't be deleted (`canDelete` is false), or undefined when it can. Goldens go through `warden golden prune` (it holds the clone lock). */
function blocker(sim: SimEntry): string | undefined {
	if (canDelete(sim)) return undefined;
	for (const b of sim.blockers) {
		if (b.kind === "leased") return `leased by ${describeOwner(b.owner)}${b.stale ? " (stale — run `warden gc`)" : ""}`;
		if (b.kind === "golden") return "golden image — use `warden golden prune`";
	}
	return "not deletable";
}

/** Every sim (all platforms, unavailable ones too) judged by the shared rules; suggested first, then running, then by name. */
async function listSims(ctx: CommandContext, rules: SimRuleOpts): Promise<Result<SimEntry[]>> {
	const sims = await judgeMachineSims(simsDeps(ctx), rules);
	if (!sims.success) return sims;
	const rank = (s: SimEntry) => (isSuggested(s) ? 0 : s.state !== "Shutdown" ? 1 : 2);
	return ok(sims.data.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)));
}

function choice(ctx: CommandContext, sim: SimEntry): Choice<string> {
	const why = blocker(sim);
	const tags = [
		sim.reasons.length > 0 ? describeReasons(sim.reasons) : undefined,
		sim.state !== "Shutdown" ? sim.state.toLowerCase() : undefined,
		sim.runtime,
		sim.owner === "warden" ? "warden" : undefined,
		sim.bytes > 0 ? formatSize(sim.bytes) : undefined,
	];
	const hint = why ?? tags.filter((t) => t !== undefined).join(", ");
	return {
		value: sim.udid,
		label: `${sim.name} ${ctx.ui.color.dim(sim.udid)}`,
		...(hint ? { hint } : {}),
		...(why ? { disabled: true } : {}),
		...(isSuggested(sim) ? { selected: true } : {}),
	};
}

/** Udids given on the command line: every one must exist and be deletable, else nothing is deleted. */
function pickByUdid(sims: SimEntry[], udids: string[]): Result<SimEntry[]> {
	const byId = new Map(sims.map((s) => [s.udid, s]));
	const picked: SimEntry[] = [];
	for (const udid of udids) {
		const sim = byId.get(udid);
		if (!sim) return err(`no simulator ${udid}`);
		const why = blocker(sim);
		if (why) return err(`${sim.name} (${udid}) is ${why}`);
		picked.push(sim);
	}
	return ok(picked);
}

/** The shared core delete path; a sim leased since the menu is reported as failed. */
async function deleteAll(ctx: CommandContext, sims: SimEntry[]): Promise<{ deleted: Deleted[]; failed: Failed[] }> {
	const result = await deleteSims(simsDeps(ctx), sims, { label: "sims delete" });
	return {
		deleted: result.removed.map((s) => ({ id: s.udid, name: s.name })),
		failed: [
			...result.skipped.map(({ entry, heldBy }) => ({
				id: entry.udid,
				name: entry.name,
				error: `leased by ${describeOwner(heldBy)}`,
			})),
			...result.failed.map(({ entry, error }) => ({ id: entry.udid, name: entry.name, error })),
		],
	};
}

type DeleteOpts = { yes?: true; json?: true; dryRun?: true; suggested?: true; stale?: string; idle?: string };

/** What to delete, or the exit code to stop with (cancelled, bad udid, nothing chosen). */
type Selection = { kind: "picked"; sims: SimEntry[] } | { kind: "exit"; code: number };

async function selectSims(
	ctx: CommandContext,
	sims: SimEntry[],
	udids: string[],
	opts: DeleteOpts
): Promise<Selection> {
	const { ui } = ctx;
	if (opts.suggested) {
		const picked = sims.filter(isSuggested);
		if (picked.length > 0) return { kind: "picked", sims: picked };
		ctx.err(ui.color.dim("no suggested simulators"));
		return { kind: "exit", code: 0 };
	}
	if (udids.length > 0) {
		const byUdid = pickByUdid(sims, udids);
		return byUdid.success ? { kind: "picked", sims: byUdid.data } : { kind: "exit", code: fail(ctx, byUdid.error) };
	}
	const answer = await ui.multiselect(
		"Select simulators to delete",
		sims.map((s) => choice(ctx, s))
	);
	if (answer === undefined) {
		ui.cancelled("Aborted.");
		return { kind: "exit", code: 1 };
	}
	const chosen = new Set(answer);
	const picked = sims.filter((s) => chosen.has(s.udid));
	if (picked.length > 0) return { kind: "picked", sims: picked };
	ctx.err(ui.color.dim("nothing selected"));
	return { kind: "exit", code: 0 };
}

async function confirmDelete(ctx: CommandContext, picked: SimEntry[]): Promise<boolean> {
	const { ui } = ctx;
	for (const s of picked) {
		const why = s.reasons.length > 0 ? ui.color.dim(` — ${describeReasons(s.reasons)}`) : "";
		ctx.err(`${ui.color.yellow(`will delete ${s.name} (${s.udid})`)}${why}`);
	}
	if ((await ui.confirm(`Delete ${picked.length} simulator(s)? This can't be undone.`)) === true) return true;
	ui.cancelled("Aborted.");
	return false;
}

function dryRun(ctx: CommandContext, picked: SimEntry[], json: boolean): number {
	const { color } = ctx.ui;
	const text = picked
		.map((s) => {
			const why = s.reasons.length > 0 ? color.dim(` — ${describeReasons(s.reasons)}`) : "";
			return `${color.yellow(`would delete ${s.name} (${s.udid})`)}${why}`;
		})
		.join("\n");
	const wouldDelete = picked.map((s) => ({ id: s.udid, name: s.name, reasons: s.reasons }));
	emit(ctx, json, { dryRun: true, wouldDelete }, text);
	return 0;
}

/** Flag combinations that can't work, checked before touching simctl. */
function usageError(ctx: CommandContext, udids: string[], opts: DeleteOpts): string | undefined {
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
 * Asks before deleting unless `--yes`. Deletes go through the shared `deleteSims` (leased to us
 * while they go), so a racing claim either wins (sim skipped) or waits it out.
 */
async function deleteCmd(ctx: CommandContext, udids: string[], opts: DeleteOpts): Promise<number> {
	const { color } = ctx.ui;
	const usage = usageError(ctx, udids, opts);
	if (usage) return fail(ctx, usage);
	const rules = parseRuleOpts(opts);
	if (!rules.success) return fail(ctx, rules.error);
	const sims = await listSims(ctx, rules.data);
	if (!sims.success) return fail(ctx, sims.error);
	if (sims.data.length === 0) {
		ctx.err(color.dim("no simulators"));
		return 0;
	}
	const selection = await selectSims(ctx, sims.data, udids, opts);
	if (selection.kind === "exit") return selection.code;
	const picked = selection.sims;
	if (opts.dryRun) return dryRun(ctx, picked, opts.json === true);
	if (!opts.yes && !(await confirmDelete(ctx, picked))) return 1;

	const result = await withSpinner(ctx, `deleting ${picked.length} simulator(s)…`, (sctx) => deleteAll(sctx, picked));
	for (const f of result.failed) ctx.err(color.red(`skipped ${f.name} (${f.id}): ${f.error}`));
	const text = result.deleted.map((d) => color.green(`deleted ${d.name} (${d.id})`)).join("\n");
	if (opts.json || text) emit(ctx, opts.json === true, result, text);
	return result.failed.length > 0 ? 1 : 0;
}

export const simsCommand = defineCommand({
	name: "sims",
	summary: "simulator + runtime disk audit (default), prune idle warden sims, delete (multi-select)",
	register: (cmd, ctx, done) => {
		registerSimsAudit(cmd, ctx, done);
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
			.action(async (udids, opts) => done(await deleteCmd(ctx, udids, opts)));
	},
});
