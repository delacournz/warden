import { processAlive } from "@delacour/warden-core/liveness";
import type { Lease, Owner, Platform } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { claimWithFlags, leasePidFor, parseClaimFlags, parsePlatform, resolveOwner } from "../claim-flags";
import type { CommandContext } from "../context";
import { type CallerLease, ensureCallerLease } from "../device-lease";
import { deviceTarget } from "../hooks/claude-pretool";
import { type UiDeviceInfo, type UiError, uiError } from "./output";

/** Label on leases `warden ui --claim` creates. */
export const UI_LEASE_LABEL = "warden ui";

/** Device-selection flags shared by every `warden ui` subcommand. */
export type UiDeviceFlags = {
	udid?: string;
	serial?: string;
	lease?: string;
	/** take over a stale/missing lease, or claim a device when none is named or held */
	claim?: boolean;
	/** platform for a claim with no device named (default ios) */
	platform?: string;
	profile?: string;
	runtime?: string;
};

/** Where the device came from. */
export type UiDeviceSource = "flag" | "WARDEN_UDID" | "WARDEN_UDIDS" | "lease" | "claim";

export type UiDevice = UiDeviceInfo & {
	lease: Lease;
	/** `claimed` = `--claim` with no device named: a fresh `warden claim` */
	action: CallerLease["action"] | "claimed";
	source: UiDeviceSource;
};

type Candidate = { id: string; platform?: Platform; source: UiDeviceSource };

/** Platform of an id warden knows (a lease, a device record), else its shape (UDID = ios, else adb serial). */
function platformOf(ctx: CommandContext, id: string): Result<Platform> {
	const store = ctx.store();
	const leased = store.listLeases().find((l) => l.resource.kind === "device" && l.resource.id === id);
	if (leased?.resource.kind === "device") return ok(leased.resource.platform);
	const known = store.listDevices().find((d) => d.id === id);
	if (known) return ok(known.platform);
	const target = deviceTarget(id);
	return target.kind === "device" ? ok(target.platform) : err(`${id} is not a simulator or emulator`);
}

function fromFlags(ctx: CommandContext, flags: UiDeviceFlags): Result<Candidate | undefined, UiError> {
	if (flags.lease !== undefined) {
		const lease = ctx.store().getLease(flags.lease);
		if (!lease) return fail(uiError("lease_not_found", `no lease ${flags.lease}`, { hint: "see warden ls" }));
		if (lease.resource.kind !== "device") {
			return fail(uiError("usage", `lease ${flags.lease} is not a device lease`));
		}
		return ok({ id: lease.resource.id, platform: lease.resource.platform, source: "flag" });
	}
	if (flags.serial !== undefined) return ok({ id: flags.serial, platform: "android", source: "flag" });
	if (flags.udid !== undefined) return ok({ id: flags.udid, source: "flag" });
	return ok(undefined);
}

function fromEnv(env: CommandContext["env"]): Candidate | undefined {
	const single = env.WARDEN_UDID?.trim();
	if (single) return { id: single, source: "WARDEN_UDID" };
	const many = (env.WARDEN_UDIDS ?? "").split(/[\s,]+/).filter((s) => s.length > 0);
	const only = many.length === 1 ? many[0] : undefined;
	return only === undefined ? undefined : { id: only, source: "WARDEN_UDIDS" };
}

function fail(error: UiError): { success: false; error: UiError } {
	return { success: false, error };
}

function claimHint(platform: string): string {
	return `run warden claim ${platform} --json, or add --claim`;
}

/** The device leases the caller holds (all of them, alive or not — they are the caller's). */
function callerDeviceLeases(ctx: CommandContext, owner: Owner, platform: Platform | undefined): Lease[] {
	return ctx
		.store()
		.listLeasesByOwner(owner)
		.filter((l) => l.resource.kind === "device" && (platform === undefined || l.resource.platform === platform));
}

/** `--claim` with no device at all: `warden claim <platform>` (profile / runtime from the flags). */
async function claimFresh(ctx: CommandContext, owner: Owner, flags: UiDeviceFlags): Promise<Result<UiDevice, UiError>> {
	const platform = parsePlatform(flags.platform ?? "ios");
	if (!platform.success) return fail(uiError("usage", platform.error));
	const parsed = parseClaimFlags(platform.data, {
		...(flags.profile !== undefined ? { profile: flags.profile } : {}),
		...(flags.runtime !== undefined ? { runtime: flags.runtime } : {}),
		label: UI_LEASE_LABEL,
	});
	if (!parsed.success) return fail(uiError("usage", parsed.error));
	const outcome = await claimWithFlags(ctx, owner, parsed.data, leasePidFor(owner));
	if (!outcome.success) return fail(uiError("failed", `claim failed: ${outcome.error}`));
	const claimed = outcome.data.claimed[0];
	if (!claimed) return fail(uiError("failed", "claim returned no device"));
	return ok({
		udid: claimed.device.id,
		platform: claimed.device.platform,
		name: claimed.device.name,
		lease: claimed.lease,
		action: "claimed",
		source: "claim",
	});
}

/** No device named: the caller's single held device, `"claim"` (with `--claim`), else an exit-2 error. */
function pickHeld(
	ctx: CommandContext,
	owner: Owner,
	flags: UiDeviceFlags,
	platform: Platform | undefined
): Result<Candidate | "claim", UiError> {
	const mine = callerDeviceLeases(ctx, owner, platform);
	if (mine.length > 1) {
		const listing = mine.map((l) => (l.resource.kind === "device" ? `${l.resource.id} (${l.resource.name})` : l.id));
		return fail(
			uiError("ambiguous_device", `several devices leased: ${listing.join(", ")}`, {
				hint: "pick one with --udid <id> (or --serial / --lease)",
				details: { leases: mine.map((l) => l.id) },
			})
		);
	}
	const first = mine[0]?.resource;
	if (first?.kind === "device") return ok({ id: first.id, platform: first.platform, source: "lease" });
	if (flags.claim === true) return ok("claim");
	return fail(
		uiError("no_device_leased", "no device leased", { hint: claimHint(platform ?? flags.platform ?? "ios") })
	);
}

/** Prove the caller may use `candidate` (heartbeat / refuse / take over with `--claim`). */
function leaseCandidate(
	ctx: CommandContext,
	owner: Owner,
	candidate: Candidate,
	claim: boolean
): Result<UiDevice, UiError> {
	const platform = candidate.platform !== undefined ? ok(candidate.platform) : platformOf(ctx, candidate.id);
	if (!platform.success) return fail(uiError("usage", platform.error));
	const pid = leasePidFor(owner);
	const leased = ensureCallerLease(ctx.store(), owner, platform.data, candidate.id, {
		now: ctx.now(),
		pidAlive: processAlive,
		claim,
		label: UI_LEASE_LABEL,
		...(pid !== undefined ? { pid } : {}),
	});
	if (!leased.success) {
		const { code, message } = leased.error;
		return fail(
			code === "device_foreign"
				? uiError(code, message)
				: uiError(code, message, { hint: `add --claim, or run warden claim ${platform.data} --json` })
		);
	}
	const { lease, action } = leased.data;
	return ok({
		udid: candidate.id,
		platform: platform.data,
		...(lease.resource.kind === "device" ? { name: lease.resource.name } : {}),
		lease,
		action,
		source: candidate.source,
	});
}

/**
 * The device a `warden ui` call acts on, and proof the caller may use it. Order: `--udid|--serial|--lease`
 * → `WARDEN_UDID` → `WARDEN_UDIDS` (if one) → the caller's own device leases (one → it; none → exit 2, or a
 * fresh claim with `--claim`; several → exit 2 listing them). A named device then goes through
 * `ensureCallerLease`: own → heartbeat, foreign live → exit 2, stale/none → only with `--claim`.
 */
export async function resolveUiDevice(ctx: CommandContext, flags: UiDeviceFlags): Promise<Result<UiDevice, UiError>> {
	const owner = resolveOwner(ctx);
	const named = fromFlags(ctx, flags);
	if (!named.success) return named;
	const platformFlag = flags.platform === undefined ? undefined : parsePlatform(flags.platform);
	if (platformFlag && !platformFlag.success) return fail(uiError("usage", platformFlag.error));
	let candidate: Candidate | "claim" | undefined = named.data ?? fromEnv(ctx.env);
	if (candidate === undefined) {
		const held = pickHeld(ctx, owner, flags, platformFlag?.data);
		if (!held.success) return held;
		candidate = held.data;
	}
	if (candidate === "claim") return claimFresh(ctx, owner, flags);
	return leaseCandidate(ctx, owner, candidate, flags.claim === true);
}
