import { formatDuration } from "@delacour/warden-core/duration";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { describeOwner, type Lease, ownerLocation, type Resource } from "@delacour/warden-core/types";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, plural, table } from "../output";
import type { StopReason } from "../remote/api.types";

export function describeResource(resource: Resource): string {
	switch (resource.kind) {
		case "device":
			return `${resource.platform} ${resource.name} (${resource.id})`;
		case "port":
			return `port ${resource.port}`;
		case "build":
			return `build ${resource.key}`;
		case "remote-device":
			return `remote ${resource.platform} ${resource.name} (${resource.id})`;
	}
}

/** Remote leases only: why warden cloud stopped their devices (the module loads only when there are some). */
async function stopReasons(ctx: CommandContext, leases: readonly Lease[]): Promise<Record<string, StopReason>> {
	if (!leases.some((l) => l.resource.kind === "remote-device")) return {};
	return (await import("../remote/claim")).remoteStopReasons(ctx, leases);
}

async function list(ctx: CommandContext, json: boolean): Promise<number> {
	const { color } = ctx.ui;
	const now = ctx.now();
	const stored = ctx.store().listLeases();
	const reasons = await stopReasons(ctx, stored);
	const leases = stored.map((lease) => {
		const stopReason = lease.resource.kind === "remote-device" ? reasons[lease.resource.id] : undefined;
		return {
			...lease,
			state: isLeaseAlive(lease, now, processAlive) ? "alive" : "stale",
			...(stopReason ? { stopReason } : {}),
		};
	});
	const rows = leases.map((l) => [
		l.id,
		describeResource(l.resource),
		l.stopReason
			? color.yellow(`stop_reason: ${l.stopReason}`)
			: l.state === "alive"
				? color.green(l.state)
				: color.yellow(l.state),
		describeOwner(l.owner),
		ownerLocation(l.owner) ?? "",
		l.label ?? "",
		formatDuration(now - l.acquiredAt),
		`${formatDuration(now - l.heartbeatAt)} ago`,
	]);
	const text =
		leases.length === 0
			? color.dim("no leases")
			: table(ctx, ["LEASE", "RESOURCE", "STATE", "OWNER", "REPO/WORKTREE", "LABEL", "AGE", "HEARTBEAT"], rows, {
					column: 4,
					keep: "end",
				});
	const stale = leases.filter((l) => l.state === "stale").length;
	const detail = `${plural(leases.length, "lease")}${stale > 0 ? ` · ${stale} stale` : ""}`;
	emit(ctx, json, { leases }, text, { scope: "ls", detail });
	return 0;
}

export const lsCommand = defineCommand({
	name: "ls",
	group: "Lease",
	summary: "list leases (resource, state, owner, repo/worktree, age, heartbeat)",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action(async (opts) => done(await list(ctx, opts.json === true)));
	},
});
