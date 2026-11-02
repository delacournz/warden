import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import {
	isEmptySelector,
	NOTHING_SELECTED,
	type SelectOptionValues,
	selectLeases,
	selectorFrom,
	withSelectOptions,
} from "../lease-select";
import { emit, reportError, warn } from "../output";

type HeartbeatOpts = SelectOptionValues & { json?: true };

async function heartbeat(ctx: CommandContext, leaseIds: string[], opts: HeartbeatOpts): Promise<number> {
	const { color } = ctx.ui;
	const selector = selectorFrom(leaseIds, opts);
	if (isEmptySelector(selector)) {
		reportError(ctx, "heartbeat", NOTHING_SELECTED);
		return 1;
	}
	const { leases, unknown } = selectLeases(ctx, selector);
	const ids = leases.map((l) => l.id);
	ctx.store().heartbeat(ids, ctx.now());
	if (leases.some((l) => l.resource.kind === "remote-device")) {
		const { heartbeatRemoteLeases } = await import("../remote/claim");
		for (const n of await heartbeatRemoteLeases(ctx, leases)) warn(ctx, n);
	}
	for (const u of unknown) reportError(ctx, "heartbeat", `no lease for ${u}`);
	emit(
		ctx,
		opts.json === true,
		{ heartbeat: ids, unknown },
		ids.length > 0 ? color.green(`heartbeat ${ids.join(" ")}`) : color.yellow("no leases")
	);
	return unknown.length > 0 ? 1 : 0;
}

export const heartbeatCommand = defineCommand({
	name: "heartbeat",
	group: "Lease",
	summary: "refresh lease heartbeats so they don't go stale",
	register: (cmd, ctx, done) => {
		withSelectOptions(cmd.argument("[leaseIds...]", "lease ids to refresh"))
			.option("--json", "machine-readable output")
			.action(async (ids, opts) => done(await heartbeat(ctx, ids, opts)));
	},
});
