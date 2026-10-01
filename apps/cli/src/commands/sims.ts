import { markWardenDevices } from "@delacour/warden-core/inventory";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { deleteSim } from "@delacour/warden-core/providers/ios";
import { describeOwner, type InventoryDevice, type Lease, type Owner } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { providerFor } from "../providers";
import { withSpinner } from "../spinner-context";
import type { Choice } from "../ui";

/** held while a sim is deleted so a concurrent `warden claim` can't lease it mid-delete */
const RESERVE_TTL_MS = 10 * 60_000;

type Sim = InventoryDevice & { lease?: Lease };
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

async function listSims(ctx: CommandContext, owner: Owner): Promise<Result<Sim[]>> {
	const inventory = await providerFor("ios", ctx, owner).inventory();
	if (!inventory.success) return inventory;
	const now = ctx.now();
	const leases = new Map<string, Lease>();
	for (const lease of ctx.store().listLeases()) {
		if (lease.resource.kind === "device" && lease.resource.platform === "ios" && isLeaseAlive(lease, now, processAlive))
			leases.set(lease.resource.id, lease);
	}
	const sims = markWardenDevices(inventory.data, ctx.store().listDevices("ios")).map((d): Sim => {
		const lease = leases.get(d.id);
		return lease ? { ...d, lease } : d;
	});
	const booted = (s: Sim) => (s.state === "shutdown" ? 1 : 0);
	return ok(sims.sort((a, b) => booted(a) - booted(b) || a.name.localeCompare(b.name)));
}

function choice(ctx: CommandContext, sim: Sim): Choice<string> {
	const why = blocker(sim);
	const tags = [
		sim.state !== "shutdown" ? sim.state : undefined,
		sim.runtime,
		sim.wardenCreated ? "warden" : undefined,
	];
	const hint = why ?? tags.filter((t) => t !== undefined).join(", ");
	return {
		value: sim.id,
		label: `${sim.name} ${ctx.ui.color.dim(sim.id)}`,
		...(hint ? { hint } : {}),
		...(why ? { disabled: true } : {}),
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
		const result = await deleteSim(ctx.exec, sim.id);
		if (result.success) {
			ctx.store().forgetDevice("ios", sim.id);
			deleted.push({ id: sim.id, name: sim.name });
		} else failed.push({ id: sim.id, name: sim.name, error: result.error });
		ctx.store().deleteLeases([lease.data.id]);
	}
	return { deleted, failed };
}

type DeleteOpts = { yes?: true; json?: true };

/** What to delete, or the exit code to stop with (cancelled, bad udid, nothing chosen). */
type Selection = { kind: "picked"; sims: Sim[] } | { kind: "exit"; code: number };

async function selectSims(ctx: CommandContext, sims: Sim[], udids: string[]): Promise<Selection> {
	const { ui } = ctx;
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
	for (const s of picked) ctx.err(ui.color.yellow(`will delete ${s.name} (${s.id})`));
	if ((await ui.confirm(`Delete ${picked.length} simulator(s)? This can't be undone.`)) === true) return true;
	ui.cancelled("Aborted.");
	return false;
}

/**
 * Permanently delete iOS simulators — picked from a multi-select menu, or given as udids. Leased
 * sims and goldens are listed but can't be picked. Asks before deleting unless `--yes`. Each sim
 * is leased to us while it goes, so a racing claim either wins (sim skipped) or waits it out.
 */
async function deleteCmd(ctx: CommandContext, udids: string[], opts: DeleteOpts): Promise<number> {
	const { ui } = ctx;
	const { color } = ui;
	if (udids.length === 0 && !ui.interactive) return fail(ctx, "not a terminal — pass udids (see `warden devices ios`)");
	if (udids.length > 0 && !ui.interactive && !opts.yes) return fail(ctx, "not a terminal — pass --yes to delete");
	const owner = resolveOwner(ctx);
	const sims = await listSims(ctx, owner);
	if (!sims.success) return fail(ctx, sims.error);
	if (sims.data.length === 0) {
		ctx.err(color.dim("no simulators"));
		return 0;
	}
	const selection = await selectSims(ctx, sims.data, udids);
	if (selection.kind === "exit") return selection.code;
	const picked = selection.sims;
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
	summary: "manage iOS simulators: delete (interactive multi-select)",
	register: (cmd, ctx, done) => {
		cmd
			.command("delete")
			.alias("rm")
			.description("pick simulators to delete from a menu (or pass udids), confirm, delete")
			.argument("[udids...]", "delete these instead of showing the menu")
			.option("-y, --yes", "don't ask before deleting")
			.option("--json", "machine-readable output")
			.action(async (udids, opts) => done(await deleteCmd(ctx, udids, opts)));
	},
});
