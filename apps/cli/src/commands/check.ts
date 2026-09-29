import { isLeaseAlive, processAlive } from "@warden/core/liveness";
import { describeOwner, ownerLocation, sameOwner } from "@warden/core/types";
import { resolveOwner, sessionOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";

type CheckOpts = { udid: string; session?: string; json?: true };

/** Exit 0 if the device is free or leased by this owner/session; 2 if another owner holds it. */
function check(ctx: CommandContext, opts: CheckOpts): number {
	const { color } = ctx.ui;
	const { udid } = opts;
	const me = opts.session !== undefined ? sessionOwner(opts.session) : resolveOwner(ctx);
	const now = ctx.now();
	const lease = ctx
		.store()
		.listLeases()
		.find((l) => l.resource.kind === "device" && l.resource.id === udid && isLeaseAlive(l, now, processAlive));
	const json = opts.json === true;
	if (!lease) {
		emit(ctx, json, { udid, free: true, mine: false }, color.green(`device ${udid} is free`));
		return 0;
	}
	if (sameOwner(lease.owner, me)) {
		emit(
			ctx,
			json,
			{ udid, free: false, mine: true, leaseId: lease.id },
			`${color.green(`device ${udid} leased by you`)} ${color.dim(`(${lease.id})`)}`
		);
		return 0;
	}
	const where = ownerLocation(lease.owner);
	const message = `device ${udid} leased by ${describeOwner(lease.owner)}${where ? ` (${where})` : ""}`;
	if (json) emit(ctx, true, { udid, free: false, mine: false, leaseId: lease.id, owner: lease.owner }, "");
	ctx.err(color.yellow(message));
	return 2;
}

export const checkCommand = defineCommand({
	name: "check",
	summary: "exit 0 if a device is free or yours, 2 if another owner holds it",
	register: (cmd, ctx, done) => {
		cmd
			.requiredOption("--udid <udid>", "device udid / serial to check")
			.option("--session <id>", "check against this agent session instead of the caller")
			.option("--json", "machine-readable output")
			.action((opts) => done(check(ctx, opts)));
	},
});
