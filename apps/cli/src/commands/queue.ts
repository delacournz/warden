import { durationParser } from "@delacour/warden-config/duration";
import { queueOrdering } from "@delacour/warden-leasing/queue";
import type { QueueRowJson } from "@delacour/warden-sdk/contracts/queue";
import { liveness } from "@delacour/warden-store/liveness";
import { leaseModel } from "@delacour/warden-store/types";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

export type QueueRow = QueueRowJson;

/** `warden queue`: claims waiting for host capacity, head first. */
function queue(ctx: CommandContext, json: boolean): number {
	const now = ctx.now();
	const rows: QueueRow[] = queueOrdering.order(ctx.store().listQueue(), now).map((e, i) => ({
		position: i + 1,
		id: e.id,
		priority: queueOrdering.priorityName(e.priority),
		effectivePriority: queueOrdering.effectivePriority(e, now),
		aged: queueOrdering.effectivePriority(e, now) - e.priority,
		ageMs: Math.max(0, now - e.enqueuedAt),
		platform: e.platform,
		profile: e.profile,
		units: e.units,
		owner: leaseModel.describeOwner(e.owner),
		...(leaseModel.ownerLocation(e.owner) !== undefined ? { where: leaseModel.ownerLocation(e.owner) } : {}),
		...(e.label !== undefined ? { label: e.label } : {}),
		...(e.pid !== undefined ? { pid: e.pid } : {}),
		...(e.pid !== undefined && !liveness.processAlive(e.pid) ? { stale: true as const } : {}),
	}));
	const { color } = ctx.ui;
	const text =
		rows.length === 0
			? color.dim("queue empty")
			: output.table(
					ctx,
					["#", "PRIORITY", "AGE", "PLATFORM", "PROFILE", "UNITS", "OWNER", "REPO/WORKTREE", "LABEL", "PID"],
					rows.map((r) => [
						String(r.position),
						r.aged > 0 ? `${r.priority} +${r.aged}` : r.priority,
						durationParser.format(r.ageMs),
						r.platform,
						r.profile,
						String(r.units),
						r.owner,
						r.where ?? "",
						r.label ?? "",
						r.pid === undefined ? "" : r.stale ? color.yellow(`${r.pid} stale`) : String(r.pid),
					])
				);
	output.emit(ctx, json, { queue: rows }, text, {
		scope: "queue",
		detail: output.plural(rows.length, "waiting claim"),
	});
	return 0;
}

export const queueCommand = defineCommand({
	name: "queue",
	group: "Lease",
	summary: "claims waiting for host capacity, head first (position, priority, age, owner)",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action((opts) => done(queue(ctx, opts.json === true)));
	},
});
