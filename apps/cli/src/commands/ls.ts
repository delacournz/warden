import { parseArgs } from "node:util";
import { formatDuration } from "@warden/core/duration";
import { isLeaseAlive, processAlive } from "@warden/core/liveness";
import { describeOwner, ownerLocation, type Resource } from "@warden/core/types";
import type { Command, CommandContext } from "../context";
import { emit, formatTable } from "../output";

const USAGE = "warden ls [--json]";

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

async function run(ctx: CommandContext): Promise<number> {
	let json: boolean;
	try {
		json =
			parseArgs({ args: ctx.argv, options: { json: { type: "boolean" } }, allowPositionals: false, strict: true })
				.values.json === true;
	} catch (error) {
		ctx.err(`warden ls: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 1;
	}
	const now = ctx.now();
	const leases = ctx
		.store()
		.listLeases()
		.map((lease) => ({ ...lease, state: isLeaseAlive(lease, now, processAlive) ? "alive" : "stale" }));
	const rows = leases.map((l) => [
		l.id,
		describeResource(l.resource),
		l.state,
		describeOwner(l.owner),
		ownerLocation(l.owner) ?? "",
		l.label ?? "",
		formatDuration(now - l.acquiredAt),
		`${formatDuration(now - l.heartbeatAt)} ago`,
	]);
	const text =
		leases.length === 0
			? "no leases"
			: formatTable(["LEASE", "RESOURCE", "STATE", "OWNER", "REPO/WORKTREE", "LABEL", "AGE", "HEARTBEAT"], rows);
	emit(ctx, json, { leases }, text);
	return 0;
}

export const lsCommand: Command = {
	name: "ls",
	summary: "list leases (resource, state, owner, repo/worktree, age, heartbeat)",
	usage: USAGE,
	run,
};
