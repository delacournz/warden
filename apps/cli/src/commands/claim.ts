import { BARE_CLAIM_AGENT_TTL_MS, DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { formatDuration } from "@delacour/warden-core/duration";
import { resolveHeadless } from "@delacour/warden-core/headless";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { maybeAutoGc } from "../autogc";
import {
	type ClaimFlags,
	type ClaimFlagValues,
	claimedJson,
	claimWithFlags,
	hintSlimmed,
	leasePidFor,
	parseClaimFlags,
	resolveOwner,
	resolvePlatform,
	withClaimOptions,
} from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, heading, reportError, table, warn } from "../output";
import { withSpinner } from "../spinner-context";

/** how long `--remote` waits for the hosted device to boot when `--wait` / `--no-wait` don't say */
const REMOTE_BOOT_WAIT_MS = 5 * 60_000;

type ClaimOpts = ClaimFlagValues & { json?: true; remote?: true; view?: true };

/** Lease, then boot / create as needed; a spinner covers the (possibly minutes-long) boot. */
async function claim(ctx: CommandContext, platformArg: string | undefined, opts: ClaimOpts): Promise<number> {
	const { color } = ctx.ui;
	if (opts.view && !opts.remote) {
		reportError(ctx, "claim", "--view needs --remote (only hosted devices have a viewer)");
		return 1;
	}
	const platform = await resolvePlatform(ctx, platformArg);
	if (!platform.success) {
		reportError(ctx, "claim", platform.error);
		return 1;
	}
	const owner = resolveOwner(ctx);
	const shortLived = owner.kind === "agent" && opts.ttl === undefined;
	const headless = resolveHeadless({ flag: opts.headless, env: ctx.env });
	const flags = parseClaimFlags(
		platform.data,
		{ ...opts, headless },
		undefined,
		shortLived ? BARE_CLAIM_AGENT_TTL_MS : DEFAULT_TTL_MS
	);
	if (!flags.success) {
		reportError(ctx, "claim", flags.error);
		return 1;
	}
	if (opts.remote) return claimRemoteCommand(ctx, platform.data, flags.data, owner, opts, shortLived);
	const { count, profile } = flags.data.request;
	if (!opts.json) heading(ctx, "claim", `${platform.data} · ${profile} ×${count}`);
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
	// after the claim: its own leases keep the background gc off the devices it just took (16-1)
	maybeAutoGc(ctx);
	if (!outcome.success) {
		reportError(ctx, "claim", outcome.error);
		return 1;
	}
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

/**
 * `claim --remote`: one hosted device through warden cloud instead of a local sim/emulator. Local capacity,
 * allocation and windows don't apply; `--profile` / `--runtime` pick the device model / OS version.
 */
async function claimRemoteCommand(
	ctx: CommandContext,
	platform: Platform,
	flags: ClaimFlags,
	owner: Owner,
	opts: ClaimOpts,
	shortLived: boolean
): Promise<number> {
	const { color } = ctx.ui;
	if (flags.request.count !== 1) {
		reportError(ctx, "claim", "--remote claims one device at a time (drop --count)");
		return 1;
	}
	if (!opts.json) heading(ctx, "claim", `${platform} · remote`);
	const { claimRemote } = await import("../remote/claim");
	const outcome = await withSpinner(ctx, `starting a remote ${platform} device…`, async (_sctx, spinner) => {
		const result = await claimRemote(ctx, {
			platform,
			...(opts.profile ? { profile: opts.profile } : {}),
			...(opts.runtime ? { runtime: opts.runtime } : {}),
			ttlMs: flags.ttlMs,
			waitMs: flags.waitMs > 0 ? flags.waitMs : REMOTE_BOOT_WAIT_MS,
			owner,
			...(flags.label ? { label: flags.label } : {}),
			...(leasePidFor(owner) !== undefined ? { pid: leasePidFor(owner) } : {}),
		});
		if (result.success) spinner.succeed(`remote ${result.data.device.id} ready`);
		else spinner.fail("remote claim failed");
		return result;
	});
	if (!outcome.success) {
		reportError(ctx, "claim", outcome.error);
		return 1;
	}
	if (shortLived) {
		warn(ctx, `lease expires in ${formatDuration(flags.ttlMs)}; hold it with: warden heartbeat`);
	}
	const { lease, device } = outcome.data;
	const leases = [
		{
			leaseId: lease.id,
			remote: true,
			remoteId: device.id,
			platform: device.platform,
			name: device.deviceModel ?? `${device.platform}-remote`,
			...(device.osVersion ? { osVersion: device.osVersion } : {}),
			action: "remote",
		},
	];
	emit(
		ctx,
		opts.json === true,
		{ leases, remoteIds: [device.id] },
		table(
			ctx,
			["LEASE", "REMOTE", "NAME", "ACTION"],
			leases.map((l) => [l.leaseId, color.bold(l.remoteId), l.name, color.dim(l.action)])
		)
	);
	if (!opts.view) return 0;
	const { attachViewer } = await import("./view");
	return attachViewer(ctx, "claim", lease, { scope: "drive", detach: false, json: opts.json === true, report: false });
}

export const claimCommand = defineCommand({
	name: "claim",
	group: "Lease",
	summary: "lease iOS sims / Android emulators (reuse, boot or create), booted and ready",
	register: (cmd, ctx, done) => {
		withClaimOptions(cmd.argument("[platform]", "ios | android (asked for when omitted in a terminal)"))
			.option("--remote", "lease a hosted device from warden cloud (warden login first)")
			.option("--view", "with --remote: open the device in the warden viewer and stay until it closes")
			.action(async (platform, opts) => done(await claim(ctx, platform, opts)));
	},
});
