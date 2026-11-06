import { formatDuration } from "@delacour/warden-core/duration";
import { processAlive } from "@delacour/warden-core/liveness";
import {
	effectivePriority,
	isDeviceWaitReason,
	priorityName,
	queueOrder,
	type WaitReason,
} from "@delacour/warden-core/queue";
import { describeOwner, ownerLocation, type Platform } from "@delacour/warden-core/types";
import { capacityEnabled } from "../capacity-deps";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, plural, table } from "../output";

export type QueueRow = {
	/** place in the boot queue; absent for a claim polling for a device (it holds no boot slot) */
	position?: number;
	/** why the claim waits (absent on a row an older binary wrote) */
	reason?: WaitReason;
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

type QueueEntry = ReturnType<CommandContext["store"]> extends { listQueue(): (infer E)[] } ? E : never;

/** One queued claim as a row; `gated` (the boot-queue order) gives its position, a claim polling for a device has none. */
function queueRow(e: QueueEntry, gated: readonly QueueEntry[], now: number): QueueRow {
	return {
		...(isDeviceWaitReason(e.reason) ? {} : { position: gated.indexOf(e) + 1 }),
		...(e.reason !== undefined ? { reason: e.reason } : {}),
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
	};
}

/** The PID column: empty, the pid, or the pid in yellow with `stale` once the process is gone. */
function pidCell(r: QueueRow, color: CommandContext["ui"]["color"]): string {
	if (r.pid === undefined) return "";
	return r.stale ? color.yellow(`${r.pid} stale`) : String(r.pid);
}

/** `warden queue`: claims waiting for host capacity, head first. */
function queue(ctx: CommandContext, json: boolean): number {
	const now = ctx.now();
	const ordered = queueOrder(ctx.store().listQueue(), now);
	const gated = ordered.filter((e) => !isDeviceWaitReason(e.reason));
	const waiting = ordered.filter((e) => isDeviceWaitReason(e.reason));
	const rows: QueueRow[] = [...gated, ...waiting].map((e) => queueRow(e, gated, now));
	const { color } = ctx.ui;
	const enforced = capacityEnabled(ctx.env);
	const note = color.dim(
		enforced
			? "capacity limits enforced (WARDEN_CAPACITY=on)"
			: "capacity limits not enforced (WARDEN_CAPACITY=on to enforce)"
	);
	const list =
		rows.length === 0
			? color.dim("queue empty")
			: table(
					ctx,
					["#", "PRIORITY", "REASON", "AGE", "PLATFORM", "PROFILE", "UNITS", "OWNER", "REPO/WORKTREE", "LABEL", "PID"],
					rows.map((r) => [
						r.position === undefined ? "-" : String(r.position),
						r.aged > 0 ? `${r.priority} +${r.aged}` : r.priority,
						r.reason ?? "",
						formatDuration(r.ageMs),
						r.platform,
						r.profile,
						String(r.units),
						r.owner,
						r.where ?? "",
						r.label ?? "",
						pidCell(r, color),
					])
				);
	const text = `${list}\n${note}`;
	emit(ctx, json, { queue: rows, enforced }, text, { scope: "queue", detail: plural(rows.length, "waiting claim") });
	return 0;
}

export const queueCommand = defineCommand({
	name: "queue",
	group: "Lease",
	summary: "claims waiting for host capacity or a free device, head first (position, priority, reason, age, owner)",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action((opts) => done(queue(ctx, opts.json === true)));
	},
});
