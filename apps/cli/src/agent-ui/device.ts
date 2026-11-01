import { type CallerLease, CallerLeaseGate } from "@delacour/warden-leasing/device-lease";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { PRIORITY } from "@delacour/warden-leasing/queue";
import { adbParser } from "@delacour/warden-providers/android";
import { DEVICE_LOCKED_HINT } from "@delacour/warden-providers/unlock-wait";
import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import { type Lease, leaseModel, type Owner, type Platform } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { claimFlagsHelpers } from "../claim-flags";
import type { CommandContext } from "../context";
import { hookClaudePretool } from "../hooks/claude-pretool";
import { physicalLock } from "../physical-lock";
import { AMBIGUOUS_HINT, physicalPickHelpers } from "../physical-pick";
import { type UiDeviceInfo, type UiError, type UiErrorCode, uiOutput } from "./output";
import { type PhoneCheck, uiPhone } from "./phone";

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
	/** drive the device even while a live warden process holds the caller's lease on it */
	force?: boolean;
	/** with `--claim` and no device named: claim a connected phone (`warden claim --physical`) */
	physical?: boolean;
};

/** How `resolveUiDevice` checks the lease: `exclusive` = refuse an own lease a live warden process holds. */
export type UiLeaseCheck = { exclusive: boolean; pidAlive?: PidAlive };

/** Where the device came from. */
export type UiDeviceSource = "flag" | "WARDEN_UDID" | "WARDEN_UDIDS" | "lease" | "claim";

export type UiDevice = UiDeviceInfo & {
	lease: Lease;
	/** `claimed` = `--claim` with no device named: a fresh `warden claim` */
	action: CallerLease["action"] | "claimed";
	source: UiDeviceSource;
};

type Candidate = { id: string; platform?: Platform; source: UiDeviceSource };

export class UiDeviceResolver {
	/** Platform of an id warden knows (a lease, a device record), else its shape (simulator UUID or physical `XXXXXXXX-XXXXXXXXXXXXXXXX` UDID = ios, else adb serial). */
	private platformOf(ctx: CommandContext, id: string): Result<Platform> {
		const store = ctx.store();
		const leased = store.listLeases().find((l) => l.resource.kind === "device" && l.resource.id === id);
		if (leased?.resource.kind === "device") return resultFactory.ok(leased.resource.platform);
		const known = store.listDevices().find((d) => d.id === id);
		if (known) return resultFactory.ok(known.platform);
		const target = hookClaudePretool.deviceTarget(id);
		return target.kind === "device"
			? resultFactory.ok(target.platform)
			: resultFactory.err(`${id} is not a simulator, emulator or physical device`);
	}

	private fromFlags(ctx: CommandContext, flags: UiDeviceFlags): Result<Candidate | undefined, UiError> {
		if (flags.lease !== undefined) {
			const lease = ctx.store().getLease(flags.lease);
			if (!lease)
				return this.fail(uiOutput.uiError("lease_not_found", `no lease ${flags.lease}`, { hint: "see warden ls" }));
			if (lease.resource.kind !== "device") {
				return this.fail(uiOutput.uiError("usage", `lease ${flags.lease} is not a device lease`));
			}
			return resultFactory.ok({ id: lease.resource.id, platform: lease.resource.platform, source: "flag" });
		}
		if (flags.serial !== undefined) return resultFactory.ok({ id: flags.serial, platform: "android", source: "flag" });
		if (flags.udid !== undefined) return resultFactory.ok({ id: flags.udid, source: "flag" });
		return resultFactory.ok(undefined);
	}

	private fromEnv(env: CommandContext["env"]): Candidate | undefined {
		const single = env.WARDEN_UDID?.trim();
		if (single) return { id: single, source: "WARDEN_UDID" };
		const many = (env.WARDEN_UDIDS ?? "").split(/[\s,]+/).filter((s) => s.length > 0);
		const only = many.length === 1 ? many[0] : undefined;
		return only === undefined ? undefined : { id: only, source: "WARDEN_UDIDS" };
	}

	private fail(error: UiError): { success: false; error: UiError } {
		return { success: false, error };
	}

	private claimHint(platform: string): string {
		return `run warden claim ${platform} --json, or add --claim`;
	}

	/** The device leases the caller holds (all of them, alive or not — they are the caller's). */
	private callerDeviceLeases(ctx: CommandContext, owner: Owner, platform: Platform | undefined): Lease[] {
		return ctx
			.store()
			.listLeasesByOwner(owner)
			.filter((l) => l.resource.kind === "device" && (platform === undefined || l.resource.platform === platform));
	}

	/** How `open` / `close --release` name the shared `warden dev` lease a call attached to. */
	/** A phone (its lease says so, or an iPhone UDID): condition and biometric verbs never reach it. */
	physicalDevice(device: UiDevice): boolean {
		const resource = device.lease.resource;
		return (resource.kind === "device" && resource.physical !== undefined) || leaseModel.isPhysicalIosId(device.udid);
	}

	sharedNote(lease: Lease): string {
		return `sharing ${lease.id} with warden dev${lease.pid === undefined ? "" : ` (pid ${lease.pid})`}`;
	}

	/** A shared (`warden dev`) lease whose holding process is alive: `warden ui` attaches to it. */
	private liveShared(lease: Lease, pidAlive: PidAlive): boolean {
		return lease.shared === true && lease.pid !== undefined && pidAlive(lease.pid);
	}

	/** A failed claim as a `warden ui` error: a phone that stayed locked is `device_locked` (exit 2), anything else `failed`. */
	private claimError(error: string): UiError {
		return physicalLock.isLockedClaimError(error)
			? uiOutput.uiError("device_locked", physicalLock.lockedClaimMessage(error), { hint: DEVICE_LOCKED_HINT })
			: uiOutput.uiError("failed", `claim failed: ${error}`);
	}

	/** `--claim` with no device at all: `warden claim <platform>` (profile / runtime from the flags). */
	private async claimFresh(
		ctx: CommandContext,
		owner: Owner,
		flags: UiDeviceFlags
	): Promise<Result<UiDevice, UiError>> {
		const platform = claimFlagsHelpers.parsePlatform(flags.platform ?? "ios");
		if (!platform.success) return this.fail(uiOutput.uiError("usage", platform.error));
		const parsed = claimFlagsHelpers.parseClaimFlags(
			platform.data,
			{
				...(flags.profile !== undefined ? { profile: flags.profile } : {}),
				...(flags.runtime !== undefined ? { runtime: flags.runtime } : {}),
				...(flags.physical === true ? { physical: true } : {}),
				label: UI_LEASE_LABEL,
			},
			undefined,
			undefined,
			PRIORITY.high
		);
		if (!parsed.success) return this.fail(uiOutput.uiError("usage", parsed.error));
		// `warden ui` is for agents: never a prompt, several usable phones are the caller's to choose between
		const picked = await physicalPickHelpers.pickPhysical(ctx, owner, [parsed.data], { prompt: false });
		if (picked.kind === "ambiguous") {
			return this.fail(
				uiOutput.uiError("ambiguous_device", physicalPickHelpers.ambiguousMessage(picked.platform, picked.candidates), {
					hint: AMBIGUOUS_HINT,
					details: { candidates: picked.candidates },
				})
			);
		}
		if (picked.kind !== "ok")
			return this.fail(
				uiOutput.uiError("failed", `claim failed: ${picked.kind === "failed" ? picked.message : "cancelled"}`)
			);
		const outcome = await claimFlagsHelpers.claimWithFlags(
			ctx,
			owner,
			picked.flags[0] ?? parsed.data,
			ownerResolver.leasePidFor(owner)
		);
		if (!outcome.success) return this.fail(this.claimError(outcome.error.message));
		const claimed = outcome.data.claimed[0];
		if (!claimed) return this.fail(uiOutput.uiError("failed", "claim returned no device"));
		return resultFactory.ok({
			udid: claimed.device.id,
			platform: claimed.device.platform,
			name: claimed.device.name,
			lease: claimed.lease,
			action: "claimed",
			source: "claim",
		});
	}

	/**
	 * No device named: the caller's single held device (of several, the one live `warden dev` device), `"claim"` (with
	 * `--claim`), else an exit-2 error.
	 */
	private pickHeld(
		ctx: CommandContext,
		owner: Owner,
		flags: UiDeviceFlags,
		platform: Platform | undefined,
		pidAlive: PidAlive
	): Result<Candidate | "claim", UiError> {
		const held = this.callerDeviceLeases(ctx, owner, platform);
		const dev = held.filter((l) => this.liveShared(l, pidAlive));
		const mine = held.length > 1 && dev.length === 1 ? dev : held;
		if (mine.length > 1) {
			const listing = mine.map((l) => (l.resource.kind === "device" ? `${l.resource.id} (${l.resource.name})` : l.id));
			return this.fail(
				uiOutput.uiError("ambiguous_device", `several devices leased: ${listing.join(", ")}`, {
					hint: "pick one with --udid <id> (or --serial / --lease)",
					details: { leases: mine.map((l) => l.id) },
				})
			);
		}
		const first = mine[0]?.resource;
		if (first?.kind === "device") return resultFactory.ok({ id: first.id, platform: first.platform, source: "lease" });
		if (flags.claim === true) return resultFactory.ok("claim");
		return this.fail(
			uiOutput.uiError("no_device_leased", "no device leased", {
				hint: this.claimHint(platform ?? flags.platform ?? "ios"),
			})
		);
	}

	/** `--claim` of a physical iPhone takes a lease: wait for it to be unlocked first (stderr; no lease is held meanwhile). */
	private async awaitUnlockedForClaim(
		ctx: CommandContext,
		owner: Owner,
		candidate: Candidate,
		platform: Platform,
		claim: boolean
	): Promise<Result<undefined, UiError>> {
		if (!(claim && platform === "ios" && leaseModel.isPhysicalIosId(candidate.id))) return resultFactory.ok(undefined);
		const unlocked = await physicalLock.awaitPhonesUnlocked(
			ctx,
			owner,
			{ platform: "ios", profile: "iphone-17", count: 1, max: 1, physical: { ids: [candidate.id] } },
			{ noWait: false }
		);
		return unlocked.success ? resultFactory.ok(undefined) : this.fail(this.claimError(unlocked.error));
	}

	private gateError(error: { code: UiErrorCode; message: string }, platform: Platform): UiError {
		const { code, message } = error;
		return code === "device_foreign" || code === "device_busy"
			? uiOutput.uiError(code, message)
			: uiOutput.uiError(code, message, { hint: `add --claim, or run warden claim ${platform} --json` });
	}

	private async undoLeftoverConditions(ctx: CommandContext, platform: Platform, id: string): Promise<void> {
		const { hostDeps } = await import("@delacour/warden-core/host-deps");
		const report = await hostDeps.undoOrphansWith(
			ctx.store(),
			{ exec: ctx.exec, env: ctx.env, now: ctx.now },
			{ platform, id }
		);
		for (const e of report.errors) ctx.err(`warden: leftover condition on ${id} not undone — ${e}`);
	}

	/** Prove the caller may use `candidate` (heartbeat / refuse / take over with `--claim`). */
	private async leaseCandidate(
		ctx: CommandContext,
		owner: Owner,
		candidate: Candidate,
		claim: boolean,
		check: UiLeaseCheck
	): Promise<Result<UiDevice, UiError>> {
		const platform =
			candidate.platform !== undefined ? resultFactory.ok(candidate.platform) : this.platformOf(ctx, candidate.id);
		if (!platform.success) return this.fail(uiOutput.uiError("usage", platform.error));
		const phone: PhoneCheck =
			platform.data === "android" && !adbParser.isEmulatorSerial(candidate.id)
				? await uiPhone.checkPhone(ctx, candidate.id)
				: { kind: "other" };
		const unlocked = await this.awaitUnlockedForClaim(ctx, owner, candidate, platform.data, claim);
		if (!unlocked.success) return unlocked;
		const pid = ownerResolver.leasePidFor(owner);
		const leased = new CallerLeaseGate(ctx.store()).ensure(owner, platform.data, candidate.id, {
			now: ctx.now(),
			pidAlive: check.pidAlive ?? liveness.processAlive,
			claim,
			label: UI_LEASE_LABEL,
			...(pid !== undefined ? { pid } : {}),
			exclusive: check.exclusive,
			...(phone.kind === "phone" ? { physical: phone.physical } : {}),
		});
		if (!leased.success) return this.fail(this.gateError(leased.error, platform.data));
		const { lease, action } = leased.data;
		// the lease is kept: the user fixes the phone (accept the prompt, replug) and retries
		const notReady = phone.kind === "phone" ? uiPhone.phoneStateError(candidate.id, phone.adbState) : undefined;
		if (notReady) return this.fail(notReady);
		if (claim && (action === "reclaimed" || action === "leased")) {
			await this.undoLeftoverConditions(ctx, platform.data, candidate.id);
		}
		return resultFactory.ok({
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
	 * fresh claim with `--claim`; several → the one live `warden dev` device, else exit 2 listing them). A named device
	 * then goes through `ensureCallerLease`: own → heartbeat (a shared `warden dev` lease its live holder keeps →
	 * `attached`; held by another live warden process, with `check.exclusive` → exit 2 `device_busy`), foreign live →
	 * exit 2, stale/none → only with `--claim`.
	 */
	async resolveUiDevice(
		ctx: CommandContext,
		flags: UiDeviceFlags,
		check: UiLeaseCheck = { exclusive: flags.force !== true }
	): Promise<Result<UiDevice, UiError>> {
		const owner = ownerResolver.resolve(ctx);
		const named = this.fromFlags(ctx, flags);
		if (!named.success) return named;
		const platformFlag = flags.platform === undefined ? undefined : claimFlagsHelpers.parsePlatform(flags.platform);
		if (platformFlag && !platformFlag.success) return this.fail(uiOutput.uiError("usage", platformFlag.error));
		let candidate: Candidate | "claim" | undefined = named.data ?? this.fromEnv(ctx.env);
		if (candidate === undefined) {
			const held = this.pickHeld(ctx, owner, flags, platformFlag?.data, check.pidAlive ?? liveness.processAlive);
			if (!held.success) return held;
			candidate = held.data;
		}
		if (candidate === "claim") return this.claimFresh(ctx, owner, flags);
		return this.leaseCandidate(ctx, owner, candidate, flags.claim === true, check);
	}
}

export const uiDeviceResolver = new UiDeviceResolver();
