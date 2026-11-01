import { LeaseSelection, leaseSelectorRules, NOTHING_SELECTED } from "@delacour/warden-leasing/lease-select";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { type SelectOptionValues, selectorFrom, withSelectOptions } from "../lease-select";
import { output } from "../output";

type HeartbeatOpts = SelectOptionValues & { json?: true };

export class HeartbeatCommand extends CliCommand {
	override readonly name = "heartbeat";
	override readonly group = "Lease";
	override readonly summary = "refresh lease heartbeats so they don't go stale";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		withSelectOptions(cmd.argument("[leaseIds...]", "lease ids to refresh"))
			.option("--json", "machine-readable output")
			.action(async (ids, opts) => done(await this.heartbeat(ctx, ids, opts)));
	}

	private async heartbeat(ctx: CommandContext, leaseIds: string[], opts: HeartbeatOpts): Promise<number> {
		const { color } = ctx.ui;
		const selector = selectorFrom(leaseIds, opts);
		if (leaseSelectorRules.isEmpty(selector)) {
			output.reportError(ctx, "heartbeat", NOTHING_SELECTED);
			return 1;
		}
		const { leases, unknown } = new LeaseSelection(ctx).select(selector);
		const ids = leases.map((l) => l.id);
		ctx.store().heartbeat(ids, ctx.now());
		for (const u of unknown) output.reportError(ctx, "heartbeat", `no lease for ${u}`);
		output.emit(
			ctx,
			opts.json === true,
			{ heartbeat: ids, unknown },
			ids.length > 0 ? color.green(`heartbeat ${ids.join(" ")}`) : color.yellow("no leases")
		);
		return unknown.length > 0 ? 1 : 0;
	}
}

export const heartbeatCommand = new HeartbeatCommand().definition();
