import { formatDuration } from "@delacour/warden-core/duration";
import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { describeOwner, ownerLocation, type Resource } from "@delacour/warden-core/types";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, formatTable } from "../output";

export function describeResource(resource: Resource): string {
	switch (resource.kind) {
		case "device":
			return `${resource.platform} ${resource.name} (${resource.id})`;
		case "port":
			return `port ${resource.port}`;
		case "build":
			return `build ${resource.key}`;
	}
}

function list(ctx: CommandContext, json: boolean): number {
	const { color } = ctx.ui;
	const now = ctx.now();
	const leases = ctx
		.store()
		.listLeases()
		.map((lease) => ({ ...lease, state: isLeaseAlive(lease, now, processAlive) ? "alive" : "stale" }));
	const rows = leases.map((l) => [
		l.id,
		describeResource(l.resource),
		l.state === "alive" ? color.green(l.state) : color.yellow(l.state),
		describeOwner(l.owner),
		ownerLocation(l.owner) ?? "",
		l.label ?? "",
		formatDuration(now - l.acquiredAt),
		`${formatDuration(now - l.heartbeatAt)} ago`,
	]);
	const text =
		leases.length === 0
			? color.dim("no leases")
			: formatTable(["LEASE", "RESOURCE", "STATE", "OWNER", "REPO/WORKTREE", "LABEL", "AGE", "HEARTBEAT"], rows, color);
	emit(ctx, json, { leases }, text);
	return 0;
}

export const lsCommand = defineCommand({
	name: "ls",
	summary: "list leases (resource, state, owner, repo/worktree, age, heartbeat)",
	register: (cmd, ctx, done) => {
		cmd.option("--json", "machine-readable output").action((opts) => done(list(ctx, opts.json === true)));
	},
});
