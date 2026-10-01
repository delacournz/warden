import { formatSize } from "@delacour/warden-core/builds/prune";
import { formatDuration, parseDuration } from "@delacour/warden-core/duration";
import { markWardenDevices } from "@delacour/warden-core/inventory";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { deleteSim, listSimDetails, type SimDetail } from "@delacour/warden-core/providers/ios";
import { type DeletionReason, suggestSimDeletions } from "@delacour/warden-core/sim-cleanup";
import { describeOwner, type Lease, type Owner } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";
import type { Choice } from "../ui";
import { registerSimsAudit } from "./sims-audit";

/** held while a sim is deleted so a concurrent `warden claim` can't lease it mid-delete */
const RESERVE_TTL_MS = 10 * 60_000;
const DEFAULT_STALE = "30d";
const DEFAULT_IDLE = "7d";
const DAY_MS = 86_400_000;

type Sim = SimDetail & { lease?: Lease; reasons: DeletionReason[] };
type Deleted = { id: string; name: string };
type Failed = Deleted & { error: string };

function fail(ctx: CommandContext, message: string): number {
	ctx.err(ctx.ui.color.red(`warden sims delete: ${message}`));
	return 1;
}

/** Why `sim` can't be deleted, or undefined when it can. Goldens go through `warden golden prune` (it holds the clone lock). */
function blocker(sim: Sim): string | undefined {
	if (sim.lease) return `leased by ${describeOwner(sim.lease.owner)}`;
	if (sim.golden) return "golden image — use `warden golden prune`";
	return undefined;
}

const suggested = (sim: Sim) => sim.reasons.length > 0 && blocker(sim) === undefined;

const age = (ms: number) => (ms >= DAY_MS ? `${Math.floor(ms / DAY_MS)}d` : formatDuration(ms));

function reasonText(r: DeletionReason): string {
	switch (r.kind) {
		case "unavailable":
			return "runtime removed";
		case "stale":
			return `not booted in ${age(r.sinceMs)}`;
		case "old-runtime":
			return `older runtime (${r.newest} installed)`;
		case "duplicate":
			return `duplicate of ${r.of.name}`;
		case "idle-pool":
			return `warden sim unused ${age(r.sinceMs)}`;
	}
}

/** `runtime removed · not booted in 45d · …` */
export function describeReasons(reasons: DeletionReason[]): string {
	return reasons.map(reasonText).join(" · ");
}

type Thresholds = { staleMs: number; idleMs: number };

/** Every iOS sim (unavailable ones too) with its lease and deletion suggestions; suggested first, then booted, then by name. */
async function listSims(ctx: CommandContext, thresholds: Thresholds): Promise<Result<Sim[]>> {
	const details = await listSimDetails(ctx.exec);
	if (!details.success) return details;
	const now = ctx.now();
	const records = ctx.store().listDevices("ios");
	const leases = new Map<string, Lease>();
	for (const lease of ctx.store().listLeases()) {
		if (lease.resource.kind === "device" && lease.resource.platform === "ios" && isLeaseAlive(lease, now, processAlive))
			leases.set(lease.resource.id, lease);
	}
	const marked = markWardenDevices(details.data, records);
	const reasons = suggestSimDeletions(marked, { now, records, ...thresholds });
	const sims = marked.map((d): Sim => {
		const lease = leases.get(d.id);
		const sim: Sim = { ...d, reasons: reasons.get(d.id) ?? [] };
		return lease ? { ...sim, lease } : sim;
	});
	const rank = (s: Sim) => (suggested(s) ? 0 : s.state === "shutdown" ? 2 : 1);
	return ok(sims.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)));
}

function choice(ctx: CommandContext, sim: Sim): Choice<string> {
	const why = blocker(sim);
	const tags = [
		sim.reasons.length > 0 ? describeReasons(sim.reasons) : undefined,
		sim.state !== "shutdown" ? sim.state : undefined,
		sim.runtime,
		sim.wardenCreated ? "warden" : undefined,
		sim.dataBytes !== undefined ? formatSize(sim.dataBytes) : undefined,
	];
	const hint = why ?? tags.filter((t) => t !== undefined).join(", ");
	return {
		value: sim.id,
		label: `${sim.name} ${ctx.ui.color.dim(sim.id)}`,
		...(hint ? { hint } : {}),
		...(why ? { disabled: true } : {}),
		...(suggested(sim) ? { selected: true } : {}),
	};
}

/** Udids given on the command line: every one must exist and be deletable, else nothing is deleted. */
function pickByUdid(sims: Sim[], udids: string[]): Result<Sim[]> {
	const byId = new Map(sims.map((s) => [s.id, s]));
	const picked: Sim[] = [];
	for (const udid of udids) {
		const sim = byId.get(udid);
		if (!sim) return err(`no simulator ${udid}`);
		const why = blocker(sim);
		if (why) return err(`${sim.name} (${udid}) is ${why}`);
		picked.push(sim);
	}
	return ok(picked);
}

/** Lease `sim` to ourselves under the store mutex; fails if someone leased it since the menu. */
function reserve(ctx: CommandContext, sim: Sim, owner: Owner): Result<Lease> {
	const store = ctx.store();
	const now = ctx.now();
	const resource = { kind: "device", platform: "ios", id: sim.id, name: sim.name } as const;
	return store.transaction(() => {
		const held = store.findLeaseByResource(resource);
		if (held && isLeaseAlive(held, now, processAlive)) return err(`leased by ${describeOwner(held.owner)}`);
		if (held) store.deleteLeases([held.id]);
		return ok(
			store.insertLease({ resource, owner, ttlMs: RESERVE_TTL_MS, pid: process.pid, label: "sims delete" }, now)
		);
	});
}

async function deleteAll(
	ctx: CommandContext,
	sims: Sim[],
	owner: Owner
): Promise<{ deleted: Deleted[]; failed: Failed[] }> {
	const deleted: Deleted[] = [];
	const failed: Failed[] = [];
	for (const sim of sims) {
		const lease = reserve(ctx, sim, owner);
		if (!lease.success) {
			failed.push({ id: sim.id, name: sim.name, error: lease.error });
			continue;
		}
		const result = await deleteSim(ctx.exec, sim.id, { shutdown: sim.available });
		if (result.success) {
			ctx.store().forgetDevice("ios", sim.id);
			deleted.push({ id: sim.id, name: sim.name });
		} else failed.push({ id: sim.id, name: sim.name, error: result.error });
		ctx.store().deleteLeases([lease.data.id]);
	}
	return { deleted, failed };
}

type DeleteOpts = { yes?: true; json?: true; dryRun?: true; suggested?: true; stale?: string; idle?: string };

/** What to delete, or the exit code to stop with (cancelled, bad udid, nothing chosen). */
type Selection = { kind: "picked"; sims: Sim[] } | { kind: "exit"; code: number };

async function selectSims(ctx: CommandContext, sims: Sim[], udids: string[], opts: DeleteOpts): Promise<Selection> {
	const { ui } = ctx;
	if (opts.suggested) {
		const picked = sims.filter(suggested);
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
	const picked = sims.filter((s) => chosen.has(s.id));
	if (picked.length > 0) return { kind: "picked", sims: picked };
	ctx.err(ui.color.dim("nothing selected"));
	return { kind: "exit", code: 0 };
}

async function confirmDelete(ctx: CommandContext, picked: Sim[]): Promise<boolean> {
	const { ui } = ctx;
	for (const s of picked) {
		const why = s.reasons.length > 0 ? ui.color.dim(` — ${describeReasons(s.reasons)}`) : "";
		ctx.err(`${ui.color.yellow(`will delete ${s.name} (${s.id})`)}${why}`);
	}
	if ((await ui.confirm(`Delete ${picked.length} simulator(s)? This can't be undone.`)) === true) return true;
	ui.cancelled("Aborted.");
	return false;
}

function dryRun(ctx: CommandContext, picked: Sim[], json: boolean): number {
	const { color } = ctx.ui;
	const text = picked
		.map((s) => {
			const why = s.reasons.length > 0 ? color.dim(` — ${describeReasons(s.reasons)}`) : "";
			return `${color.yellow(`would delete ${s.name} (${s.id})`)}${why}`;
		})
		.join("\n");
	const wouldDelete = picked.map((s) => ({ id: s.id, name: s.name, reasons: s.reasons }));
	emit(ctx, json, { dryRun: true, wouldDelete }, text);
	return 0;
}

function parseThresholds(opts: DeleteOpts): Result<Thresholds> {
	const stale = parseDuration(opts.stale ?? DEFAULT_STALE);
	if (!stale.success) return err(`--stale: ${stale.error}`);
	const idle = parseDuration(opts.idle ?? DEFAULT_IDLE);
	if (!idle.success) return err(`--idle: ${idle.error}`);
	return ok({ staleMs: stale.data, idleMs: idle.data });
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
 * Permanently delete iOS simulators — picked from a multi-select menu, given as udids, or every
 * suggestion (`--suggested`). Suggested sims (runtime removed, stale, older runtime, duplicate,
 * idle warden sim) start ticked. Leased sims and goldens are listed but can't be picked. Asks
 * before deleting unless `--yes`. Each sim is leased to us while it goes, so a racing claim either
 * wins (sim skipped) or waits it out.
 */
async function deleteCmd(ctx: CommandContext, udids: string[], opts: DeleteOpts): Promise<number> {
	const { color } = ctx.ui;
	const usage = usageError(ctx, udids, opts);
	if (usage) return fail(ctx, usage);
	const thresholds = parseThresholds(opts);
	if (!thresholds.success) return fail(ctx, thresholds.error);
	const owner = resolveOwner(ctx);
	const sims = await listSims(ctx, thresholds.data);
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

	const result = await withSpinner(ctx, `deleting ${picked.length} simulator(s)…`, (sctx) =>
		deleteAll(sctx, picked, owner)
	);
	for (const f of result.failed) ctx.err(color.red(`skipped ${f.name} (${f.id}): ${f.error}`));
	const text = result.deleted.map((d) => color.green(`deleted ${d.name} (${d.id})`)).join("\n");
	if (opts.json || text) emit(ctx, opts.json === true, result, text);
	return result.failed.length > 0 ? 1 : 0;
}

export const simsCommand = defineCommand({
	name: "sims",
	summary: "simulator disk audit (default), prune idle warden sims, delete (multi-select)",
	register: (cmd, ctx, done) => {
		registerSimsAudit(cmd, ctx, done);
		cmd
			.command("delete")
			.alias("rm")
			.description("pick simulators to delete from a menu (suggestions pre-ticked) or pass udids, confirm, delete")
			.argument("[udids...]", "delete these instead of showing the menu")
			.option("--suggested", "delete every suggested sim instead of showing the menu")
			.option("--stale <duration>", `suggest non-warden sims not booted this long (default ${DEFAULT_STALE})`)
			.option("--idle <duration>", `suggest warden sims unused this long (default ${DEFAULT_IDLE})`)
			.option("-y, --yes", "don't ask before deleting")
			.option("--dry-run", "only show what would be deleted")
			.option("--json", "machine-readable output")
			.action(async (udids, opts) => done(await deleteCmd(ctx, udids, opts)));
	},
});
