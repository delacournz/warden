import { BARE_CLAIM_AGENT_TTL_MS, DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { formatDuration } from "@delacour/warden-core/duration";
import { resolveHeadless } from "@delacour/warden-core/headless";
import { maybeAutoGc } from "../autogc";
import {
	type ClaimFlagValues,
	claimedJson,
	claimWithFlags,
	hintSlimmed,
	isPhysicalClaim,
	leasePidFor,
	parseClaimFlags,
	resolveOwner,
	resolvePlatform,
	withClaimOptions,
	withPhysicalOptions,
} from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, heading, reportError, table, warn } from "../output";
import { reportClaimFailure } from "../physical-lock";
import { canPrompt, pickPhysical, reportPick } from "../physical-pick";
import { withSpinner } from "../spinner-context";

type ClaimOpts = ClaimFlagValues & { serial?: string[]; udid?: string[]; json?: true };

/** Lease, then boot / create as needed; a spinner covers the (possibly minutes-long) boot. */
async function claim(ctx: CommandContext, platformArg: string | undefined, opts: ClaimOpts): Promise<number> {
	const { color } = ctx.ui;
	const platform = await resolvePlatform(ctx, platformArg);
	if (!platform.success) {
		reportError(ctx, "claim", platform.error);
		return 1;
	}
	const owner = resolveOwner(ctx);
	const shortLived = owner.kind === "agent" && opts.ttl === undefined;
	const named = {
		...opts,
		...(opts.serial ? { physicalSerial: opts.serial } : {}),
		...(opts.udid ? { physicalUdid: opts.udid } : {}),
	};
	const headless = isPhysicalClaim(named) ? opts.headless : resolveHeadless({ flag: opts.headless, env: ctx.env });
	const flags = parseClaimFlags(
		platform.data,
		{ ...named, headless },
		undefined,
		shortLived ? BARE_CLAIM_AGENT_TTL_MS : DEFAULT_TTL_MS
	);
	if (!flags.success) {
		reportError(ctx, "claim", flags.error);
		return 1;
	}
	// before the spinner and any lease: several usable phones are asked about, or refused (ambiguous_device, exit 2)
	const picked = await pickPhysical(ctx, owner, [flags.data], { prompt: canPrompt(ctx, { json: opts.json }) });
	if (picked.kind !== "ok") return reportPick(ctx, "claim", picked);
	const claimFlags = picked.flags[0] ?? flags.data;
	const { count, profile, physical } = claimFlags.request;
	const kind = physical ? "physical" : profile;
	if (!opts.json) heading(ctx, "claim", `${platform.data} · ${kind} ×${count}`);
	const outcome = await withSpinner(
		ctx,
		`claiming ${count} ${kind} ${platform.data} device(s)…`,
		async (sctx, spinner) => {
			const result = await claimWithFlags(sctx, owner, claimFlags, leasePidFor(owner));
			if (result.success) spinner.succeed(`claimed ${result.data.claimed.map((c) => c.device.name).join(", ")}`);
			else spinner.fail(`claim failed`);
			return result;
		}
	);
	// after the claim: its own leases keep the background gc off the devices it just took (16-1)
	maybeAutoGc(ctx);
	if (!outcome.success) return reportClaimFailure(ctx, "claim", outcome.error);
	if (opts.slim === false) hintSlimmed(ctx, outcome.data);
	if (shortLived) {
		warn(
			ctx,
			`lease expires in ${formatDuration(flags.data.ttlMs)}; hold it with: warden dev … / warden run … / warden heartbeat`
		);
	}
	const leases = claimedJson(outcome.data);
	emit(
		ctx,
		opts.json === true,
		{ leases, udids: leases.map((l) => l.udid), reclaimed: outcome.data.reclaimed },
		table(
			ctx,
			["LEASE", "UDID", "NAME", "ACTION"],
			leases.map((l) => [l.leaseId, color.bold(l.udid), l.name, color.dim(l.action)])
		)
	);
	return 0;
}

export const claimCommand = defineCommand({
	name: "claim",
	group: "Lease",
	summary: "lease iOS sims / Android emulators (reuse, boot or create), booted and ready",
	register: (cmd, ctx, done) => {
		withPhysicalOptions(
			withClaimOptions(cmd.argument("[platform]", "ios | android (asked for when omitted in a terminal)"))
		).action(async (platform, opts) => done(await claim(ctx, platform, opts)));
	},
});
