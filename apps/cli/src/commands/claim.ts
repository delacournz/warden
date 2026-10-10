import type { ClaimedDevice } from "@delacour/warden-core/claim";
import { BARE_CLAIM_AGENT_TTL_MS, DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { formatDuration } from "@delacour/warden-core/duration";
import { slimSimulator } from "@delacour/warden-core/sims/slim";
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

/**
 * A plain claim must not hand out a device an e2e/batch run left slimmed: re-enable its disabled
 * jobs and clear the record. Wrapper claims (`e2e`, `batch`, `run`) don't come through here — they
 * slim after claiming anyway. `enable` only takes effect on the device's next boot; jobs already
 * booted out stay down until then (said so on stderr).
 */
async function restoreSlimmed(ctx: CommandContext, claimed: ClaimedDevice[]): Promise<void> {
	for (const { device } of claimed) {
		if (device.platform !== "ios") continue;
		const res = await slimSimulator(ctx.exec, device.id, { restore: true });
		if (!res.success) continue;
		ctx.store().setSlimmed("ios", device.id, undefined);
		if (res.data.length > 0) {
			ctx.err(
				ctx.ui.color.yellow(
					`warden claim: ${device.name} was slimmed — re-enabled ${res.data.length} slimmed job(s); fully effective after its next reboot`
				)
			);
		}
	}
}

/** Lease, then boot / create as needed; a spinner covers the (possibly minutes-long) boot. */
async function claim(ctx: CommandContext, platformArg: string | undefined, opts: ClaimOpts): Promise<number> {
	const { color } = ctx.ui;
	const platform = await resolvePlatform(ctx, platformArg);
	if (!platform.success) {
		ctx.err(color.red(`warden claim: ${platform.error}`));
		return 1;
	}
	const owner = resolveOwner(ctx);
	const shortLived = owner.kind === "agent" && opts.ttl === undefined;
	const flags = parseClaimFlags(platform.data, opts, undefined, shortLived ? BARE_CLAIM_AGENT_TTL_MS : DEFAULT_TTL_MS);
	if (!flags.success) {
		ctx.err(color.red(`warden claim: ${flags.error}`));
		return 1;
	}
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
	if (shortLived) {
		ctx.err(
			color.yellow(
				`lease expires in ${formatDuration(flags.data.ttlMs)}; hold it with: warden dev … / warden run … / warden heartbeat`
			)
		);
	}
	await restoreSlimmed(ctx, outcome.data.claimed);
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
