import { durationParser } from "@delacour/warden-config/duration";
import type { LsJson } from "@delacour/warden-sdk/contracts/leases";
import { leaseViews } from "@delacour/warden-sdk/lease-view";
import { liveness } from "@delacour/warden-store/liveness";
import { leaseModel, type Resource } from "@delacour/warden-store/types";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

const HEADERS = ["LEASE", "RESOURCE", "STATE", "OWNER", "REPO/WORKTREE", "LABEL", "AGE", "HEARTBEAT"];

export class LsCommand extends CliCommand {
	override readonly name = "ls";
	override readonly group = "Lease";
	override readonly summary = "list leases (resource, state, owner, repo/worktree, age, heartbeat)";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd.option("--json", "machine-readable output").action((opts) => done(this.list(ctx, opts.json === true)));
	}

	describeResource(resource: Resource): string {
		switch (resource.kind) {
			case "device":
				return `${resource.platform} ${resource.name} (${resource.id})${resource.physical ? " [physical]" : ""}`;
			case "port":
				return `port ${resource.port}`;
			case "build":
				return `build ${resource.key}`;
		}
	}

	private list(ctx: CommandContext, json: boolean): number {
		const { color } = ctx.ui;
		const now = ctx.now();
		const leases: LsJson["leases"] = leaseViews.withState(ctx.store().listLeases(), now, liveness.processAlive);
		const withProvider = leases.some((l) => l.provider !== undefined);
		const rows = leases.map((l) => [
			l.id,
			this.describeResource(l.resource),
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
				: output.table(
						ctx,
						[...HEADERS.slice(0, 2), ...(withProvider ? ["PROVIDER"] : []), ...HEADERS.slice(2)],
						rows,
						{
							column: withProvider ? 5 : 4,
							keep: "end",
						}
					);
		const stale = leases.filter((l) => l.state === "stale").length;
		const detail = `${output.plural(leases.length, "lease")}${stale > 0 ? ` · ${stale} stale` : ""}`;
		output.emit(ctx, json, { leases }, text, { scope: "ls", detail });
		return 0;
	}
}

export const lsCli = new LsCommand();
export const lsCommand = lsCli.definition();
