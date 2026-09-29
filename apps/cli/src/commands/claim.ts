import { parseArgs } from "node:util";
import {
	CLAIM_OPTIONS,
	CLAIM_USAGE_FLAGS,
	claimedJson,
	claimWithFlags,
	leasePidFor,
	parseClaimFlags,
	resolveOwner,
} from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { emit, formatTable } from "../output";

async function run(ctx: CommandContext): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(ctx.argv);
	} catch (error) {
		ctx.err(`warden claim: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const flags = parseClaimFlags(parsed.positionals[0], parsed.values);
	if (!flags.success) {
		ctx.err(`warden claim: ${flags.error}`);
		return 1;
	}
	const owner = resolveOwner(ctx);
	const outcome = await claimWithFlags(ctx, owner, flags.data, leasePidFor(owner));
	if (!outcome.success) {
		ctx.err(`warden claim: ${outcome.error}`);
		return 1;
	}
	const leases = claimedJson(outcome.data);
	emit(
		ctx,
		parsed.values.json === true,
		{ leases, udids: leases.map((l) => l.udid), reclaimed: outcome.data.reclaimed },
		formatTable(
			["LEASE", "UDID", "NAME", "ACTION"],
			leases.map((l) => [l.leaseId, l.udid, l.name, l.action])
		)
	);
	return 0;
}

function parse(argv: string[]) {
	return parseArgs({ args: argv, options: CLAIM_OPTIONS, allowPositionals: true, strict: true });
}

export const claimCommand: Command = {
	name: "claim",
	summary: "lease iOS sims / Android emulators (reuse, boot or create), booted and ready",
	usage: `warden claim ios|android ${CLAIM_USAGE_FLAGS}`,
	run,
};
