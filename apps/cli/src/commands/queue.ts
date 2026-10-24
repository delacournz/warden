import { formatDuration } from "@delacour/warden-core/duration";
import { processAlive } from "@delacour/warden-core/liveness";
import { effectivePriority, priorityName, queueOrder } from "@delacour/warden-core/queue";
import { describeOwner, ownerLocation, type Platform } from "@delacour/warden-core/types";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, plural, table } from "../output";

export type QueueRow = {
	position: number;
	id: string;
	priority: string;
	effectivePriority: number;
	/** points earned by waiting (aging) */
	aged: number;
	ageMs: number;
	platform: Platform;
	profile: string;
	units: number;
	owner: string;
	where?: string;
	label?: string;
	pid?: number;
	/** the waiting process is gone; its row is reclaimed by the next claim */
	stale?: true;
};

/** `warden queue`: claims waiting for host capacity, head first. */
function queue(ctx: CommandContext, json: boolean): number {
	const now = ctx.now();
	const rows: QueueRow[] = queueOrder(ctx.store().listQueue(), now).map((e, i) => ({
		position: i + 1,
		id: e.id,
		priority: priorityName(e.priority),
		effectivePriority: effectivePriority(e, now),
		aged: effectivePriority(e, now) - e.priority,
		ageMs: Math.max(0, now - e.enqueuedAt),
		platform: e.platform,
		profile: e.profile,
		units: e.units,
		owner: describeOwner(e.owner),
		...(ownerLocation(e.owner) !== undefined ? { where: ownerLocation(e.owner) } : {}),
		...(e.label !== undefined ? { label: e.label } : {}),
		...(e.pid !== undefined ? { pid: e.pid } : {}),
		...(e.pid !== undefined && !processAlive(e.pid) ? { stale: true as const } : {}),
	}));
	const { color } = ctx.ui;
	const text =
		rows.length === 0
			? color.dim("queue empty")
			: table(
					ctx,
					["#", "PRIORITY", "AGE", "PLATFORM", "PROFILE", "UNITS", "OWNER", "REPO/WORKTREE", "LABEL", "PID"],
					rows.map((r) => [
						String(r.position),
						r.aged > 0 ? `${r.priority} +${r.aged}` : r.priority,
						formatDuration(r.ageMs),
						r.platform,
						r.profile,
						String(r.units),
						r.owner,
						r.where ?? "",
						r.label ?? "",
						r.pid === undefined ? "" : r.stale ? color.yellow(`${r.pid} stale`) : String(r.pid),
					])
				);
	emit(ctx, json, { queue: rows }, text, { scope: "queue", detail: plural(rows.length, "waiting claim") });
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
