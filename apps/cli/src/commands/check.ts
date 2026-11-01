import { ownerResolver } from "@delacour/warden-leasing/owner";
import type { CheckJson } from "@delacour/warden-sdk/contracts/leases";
import { liveness } from "@delacour/warden-store/liveness";
import { leaseModel } from "@delacour/warden-store/types";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

type CheckOpts = { udid: string; session?: string; json?: true };

/** Exit 0 if the device is free or leased by this owner/session; 2 if another owner holds it. */
function check(ctx: CommandContext, opts: CheckOpts): number {
	const { color } = ctx.ui;
	const { udid } = opts;
	const me = opts.session !== undefined ? ownerResolver.sessionOwner(opts.session) : ownerResolver.resolve(ctx);
	const now = ctx.now();
	const lease = ctx
		.store()
		.listLeases()
		.find(
			(l) =>
				l.resource.kind === "device" && l.resource.id === udid && liveness.isLeaseAlive(l, now, liveness.processAlive)
		);
	const json = opts.json === true;
	if (!lease) {
		const free: CheckJson = { udid, free: true, mine: false };
		output.emit(ctx, json, free, color.green(`device ${udid} is free`));
		return 0;
	}
	if (leaseModel.sameOwner(lease.owner, me)) {
		const mine: CheckJson = { udid, free: false, mine: true, leaseId: lease.id };
		output.emit(ctx, json, mine, `${color.green(`device ${udid} leased by you`)} ${color.dim(`(${lease.id})`)}`);
		return 0;
	}
	const where = leaseModel.ownerLocation(lease.owner);
	const message = `device ${udid} leased by ${leaseModel.describeOwner(lease.owner)}${where ? ` (${where})` : ""}`;
	const held: CheckJson = { udid, free: false, mine: false, leaseId: lease.id, owner: lease.owner };
	if (json) output.emit(ctx, true, held, "");
	output.warn(ctx, message);
	return 2;
}

export const checkCommand = defineCommand({
	name: "check",
	group: "Lease",
	summary: "exit 0 if a device is free or yours, 2 if another owner holds it",
	register: (cmd, ctx, done) => {
		cmd
			.requiredOption("--udid <udid>", "device udid / serial to check")
			.option("--session <id>", "check against this agent session instead of the caller")
			.option("--json", "machine-readable output")
			.action((opts) => done(check(ctx, opts)));
	},
});
