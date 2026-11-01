import { BARE_CLAIM_AGENT_TTL_MS, DEFAULT_TTL_MS } from "@delacour/warden-config/config.defaults";
import { durationParser } from "@delacour/warden-config/duration";
import { claimRequestRules } from "@delacour/warden-leasing/claim-request";
import { headlessResolver } from "@delacour/warden-leasing/headless";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import type { ClaimedDeviceJson, ClaimJson } from "@delacour/warden-sdk/contracts/claim";
import { autoGc } from "../autogc";
import { type ClaimFlagValues, claimFlagsHelpers } from "../claim-flags";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";
import { physicalLock } from "../physical-lock";
import { physicalPickHelpers } from "../physical-pick";
import { spinnerContext } from "../spinner-context";

type ClaimOpts = ClaimFlagValues & { serial?: string[]; udid?: string[]; json?: true };

export class ClaimCommand extends CliCommand {
	override readonly name = "claim";
	override readonly group = "Lease";
	override readonly summary = "lease iOS sims / Android emulators (reuse, boot or create), booted and ready";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		claimFlagsHelpers
			.withPhysicalOptions(
				claimFlagsHelpers.withClaimOptions(
					cmd.argument("[platform]", "ios | android (asked for when omitted in a terminal)")
				)
			)
			.action(async (platform, opts) => done(await this.claim(ctx, platform, opts)));
	}

	/** Lease, then boot / create as needed; a spinner covers the (possibly minutes-long) boot. */
	private async claim(ctx: CommandContext, platformArg: string | undefined, opts: ClaimOpts): Promise<number> {
		const { color } = ctx.ui;
		const platform = await claimFlagsHelpers.resolvePlatform(ctx, platformArg);
		if (!platform.success) {
			output.reportError(ctx, "claim", platform.error);
			return 1;
		}
		const owner = ownerResolver.resolve(ctx);
		const shortLived = owner.kind === "agent" && opts.ttl === undefined;
		const named = {
			...opts,
			...(opts.serial ? { physicalSerial: opts.serial } : {}),
			...(opts.udid ? { physicalUdid: opts.udid } : {}),
		};
		const headless = claimFlagsHelpers.isPhysicalClaim(named)
			? opts.headless
			: headlessResolver.resolve({ flag: opts.headless, env: ctx.env });
		const flags = claimFlagsHelpers.parseClaimFlags(
			platform.data,
			{ ...named, headless },
			undefined,
			shortLived ? BARE_CLAIM_AGENT_TTL_MS : DEFAULT_TTL_MS
		);
		if (!flags.success) {
			output.reportError(ctx, "claim", flags.error);
			return 1;
		}
		// before the spinner and any lease: several usable phones are asked about, or refused (ambiguous_device, exit 2)
		const picked = await physicalPickHelpers.pickPhysical(ctx, owner, [flags.data], {
			prompt: physicalPickHelpers.canPrompt(ctx, { json: opts.json }),
		});
		if (picked.kind !== "ok") return physicalPickHelpers.reportPick(ctx, "claim", picked);
		const claimFlags = picked.flags[0] ?? flags.data;
		const { count, profile, physical } = claimFlags.request;
		const kind = physical ? "physical" : profile;
		if (!opts.json) output.heading(ctx, "claim", `${platform.data} · ${kind} ×${count}`);
		const outcome = await spinnerContext.withSpinner(
			ctx,
			`claiming ${count} ${kind} ${platform.data} device(s)…`,
			async (sctx, spinner) => {
				const result = await claimFlagsHelpers.claimWithFlags(
					sctx,
					owner,
					claimFlags,
					ownerResolver.leasePidFor(owner)
				);
				if (result.success) spinner.succeed(`claimed ${result.data.claimed.map((c) => c.device.name).join(", ")}`);
				else spinner.fail(`claim failed`);
				return result;
			}
		);
		// after the claim: its own leases keep the background gc off the devices it just took (16-1)
		autoGc.maybeAutoGc(ctx);
		if (!outcome.success) return physicalLock.reportClaimFailure(ctx, "claim", outcome.error.message);
		if (opts.slim === false) claimFlagsHelpers.hintSlimmed(ctx, outcome.data);
		if (shortLived) {
			output.warn(
				ctx,
				`lease expires in ${durationParser.format(flags.data.ttlMs)}; hold it with: warden dev … / warden run … / warden heartbeat`
			);
		}
		const leases: ClaimedDeviceJson[] = claimRequestRules.claimedJson(outcome.data);
		const doc: ClaimJson = { leases, udids: leases.map((l) => l.udid), reclaimed: outcome.data.reclaimed };
		output.emit(
			ctx,
			opts.json === true,
			doc,
			output.table(
				ctx,
				["LEASE", "UDID", "NAME", "ACTION"],
				leases.map((l) => [l.leaseId, color.bold(l.udid), l.name, color.dim(l.action)])
			)
		);
		return 0;
	}
}

export const claimCommand = new ClaimCommand().definition();
