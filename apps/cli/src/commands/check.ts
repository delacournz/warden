import { parseArgs } from "node:util";
import { isLeaseAlive, processAlive } from "@warden/core/liveness";
import { describeOwner, ownerLocation, sameOwner } from "@warden/core/types";
import { resolveOwner, sessionOwner } from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { emit } from "../output";

const USAGE = "warden check --udid X [--session S] [--json]";

/** Exit 0 if the device is free or leased by this owner/session; 2 if another owner holds it. */
async function run(ctx: CommandContext): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(ctx.argv);
	} catch (error) {
		ctx.err(`warden check: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 1;
	}
	const { values } = parsed;
	const udid = values.udid;
	if (udid === undefined) {
		ctx.err(`warden check: --udid is required\n${USAGE}`);
		return 1;
	}
	const me = values.session !== undefined ? sessionOwner(values.session) : resolveOwner(ctx);
	const now = ctx.now();
	const lease = ctx
		.store()
		.listLeases()
		.find((l) => l.resource.kind === "device" && l.resource.id === udid && isLeaseAlive(l, now, processAlive));
	const json = values.json === true;
	if (!lease) {
		emit(ctx, json, { udid, free: true, mine: false }, `device ${udid} is free`);
		return 0;
	}
	if (sameOwner(lease.owner, me)) {
		emit(ctx, json, { udid, free: false, mine: true, leaseId: lease.id }, `device ${udid} leased by you (${lease.id})`);
		return 0;
	}
	const where = ownerLocation(lease.owner);
	const message = `device ${udid} leased by ${describeOwner(lease.owner)}${where ? ` (${where})` : ""}`;
	if (json) emit(ctx, true, { udid, free: false, mine: false, leaseId: lease.id, owner: lease.owner }, "");
	ctx.err(message);
	return 2;
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		options: { udid: { type: "string" }, session: { type: "string" }, json: { type: "boolean" } },
		allowPositionals: false,
		strict: true,
	});
}

export const checkCommand: Command = {
	name: "check",
	summary: "exit 0 if a device is free or yours, 2 if another owner holds it",
	usage: USAGE,
	run,
};
