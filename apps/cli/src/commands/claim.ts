import { maybeAutoGc } from "../autogc";
import {
	type ClaimFlagValues,
	claimedJson,
	claimWithFlags,
	leasePidFor,
	parseClaimFlags,
	resolveOwner,
	resolvePlatform,
	withClaimOptions,
} from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, formatTable } from "../output";
import { withSpinner } from "../spinner-context";

type ClaimOpts = ClaimFlagValues & { json?: true };

/** Lease, then boot / create as needed; a spinner covers the (possibly minutes-long) boot. */
async function claim(ctx: CommandContext, platformArg: string | undefined, opts: ClaimOpts): Promise<number> {
	const { color } = ctx.ui;
	const platform = await resolvePlatform(ctx, platformArg);
	if (!platform.success) {
		ctx.err(color.red(`warden claim: ${platform.error}`));
		return 1;
	}
	const flags = parseClaimFlags(platform.data, opts);
	if (!flags.success) {
		ctx.err(color.red(`warden claim: ${flags.error}`));
		return 1;
	}
	const owner = resolveOwner(ctx);
	maybeAutoGc(ctx);
	const { count, profile } = flags.data.request;
	const outcome = await withSpinner(
		ctx,
		`claiming ${count} ${profile} ${platform.data} device(s)…`,
		async (sctx, spinner) => {
			const result = await claimWithFlags(sctx, owner, flags.data, leasePidFor(owner));
			if (result.success) spinner.succeed(`claimed ${result.data.claimed.map((c) => c.device.name).join(", ")}`);
			else spinner.fail(`claim failed`);
			return result;
		}
	);
	if (!outcome.success) {
		ctx.err(color.red(`warden claim: ${outcome.error}`));
		return 1;
	}
	const leases = claimedJson(outcome.data);
	emit(
		ctx,
		opts.json === true,
		{ leases, udids: leases.map((l) => l.udid), reclaimed: outcome.data.reclaimed },
		formatTable(
			["LEASE", "UDID", "NAME", "ACTION"],
			leases.map((l) => [l.leaseId, color.bold(l.udid), l.name, color.dim(l.action)]),
			color
		)
	);
	return 0;
}

export const claimCommand = defineCommand({
	name: "claim",
	summary: "lease iOS sims / Android emulators (reuse, boot or create), booted and ready",
	register: (cmd, ctx, done) => {
		withClaimOptions(cmd.argument("[platform]", "ios | android (asked for when omitted in a terminal)")).action(
			async (platform, opts) => done(await claim(ctx, platform, opts))
		);
	},
});
