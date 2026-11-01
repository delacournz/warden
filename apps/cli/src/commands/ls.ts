import { durationParser } from "@delacour/warden-config/duration";
import type { LsJson } from "@delacour/warden-sdk/contracts/leases";
import { leaseViews } from "@delacour/warden-sdk/lease-view";
import { liveness } from "@delacour/warden-store/liveness";
import { leaseModel, type Resource } from "@delacour/warden-store/types";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, plural, table } from "../output";

export function describeResource(resource: Resource): string {
	switch (resource.kind) {
		case "device":
			return `${resource.platform} ${resource.name} (${resource.id})${resource.physical ? " [physical]" : ""}`;
		case "port":
			return `port ${resource.port}`;
		case "build":
			return `build ${resource.key}`;
	}
}

const HEADERS = ["LEASE", "RESOURCE", "STATE", "OWNER", "REPO/WORKTREE", "LABEL", "AGE", "HEARTBEAT"];

function list(ctx: CommandContext, json: boolean): number {
	const { color } = ctx.ui;
	const now = ctx.now();
	const leases: LsJson["leases"] = leaseViews.withState(ctx.store().listLeases(), now, liveness.processAlive);
	const withProvider = leases.some((l) => l.provider !== undefined);
	const rows = leases.map((l) => [
		l.id,
		describeResource(l.resource),
		...(withProvider ? [l.provider ?? "bundled"] : []),
		l.state === "alive" ? color.green(l.state) : color.yellow(l.state),
		leaseModel.describeOwner(l.owner),
		leaseModel.ownerLocation(l.owner) ?? "",
		l.label ?? "",
		durationParser.format(now - l.acquiredAt),
		`${durationParser.format(now - l.heartbeatAt)} ago`,
	]);
	const text =
		leases.length === 0
			? color.dim("no leases")
			: table(ctx, [...HEADERS.slice(0, 2), ...(withProvider ? ["PROVIDER"] : []), ...HEADERS.slice(2)], rows, {
					column: withProvider ? 5 : 4,
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
		cmd.option("--json", "machine-readable output").action((opts) => done(list(ctx, opts.json === true)));
	},
});
