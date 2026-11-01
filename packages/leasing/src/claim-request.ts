import type { SlimProfile } from "@delacour/warden-config/slim.profile";
import { type SlimSetting, slimPolicy } from "@delacour/warden-config/slim-policy";
import { Adb } from "@delacour/warden-providers/android";
import { biometricProfiles } from "@delacour/warden-providers/biometrics";
import type { DeviceRequest, Owner } from "@delacour/warden-store/types";
import { leaseModel } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { capacityMath } from "./capacity";
import { CapacityDepsBuilder } from "./capacity-deps";
import { type ClaimedDevice, type ClaimOutcome, type ClaimResult, ClaimService } from "./claim";
import type { LeaseHost, ProviderOptions } from "./lease-host";
import { PRIORITY, queueOrdering } from "./queue";
import { type DetachLock, type HideDeps, type HideStart, SimWindowArranger, SimWindowHider } from "./sim-windows";

/** Where a claim's `slim` can come from (see `resolveSlim`): `--slim` / `--no-slim`, the suite / preset, the top-level config. */
export type SlimLayers = {
	flag?: boolean | undefined;
	config?: SlimSetting | undefined;
	topLevel?: SlimSetting | undefined;
};

/** A validated device claim: what to lease, how long to wait for it and at what priority. */
export type ClaimRequest = {
	request: DeviceRequest;
	/** how long the claim may wait for a free device / host capacity; 0 = fail at once */
	waitMs: number;
	/** `--priority`, when given (beats `WARDEN_PRIORITY` and the command's default) */
	priority?: number;
	/** the calling command's priority when neither `--priority` nor `WARDEN_PRIORITY` says */
	defaultPriority?: number;
	/** `--max` was not given: with capacity on, the pool grows to what the machine allows */
	maxDefaulted?: true;
	ttlMs: number;
	label?: string;
	/** iOS: close the claimed sims' Simulator.app windows instead of tiling them */
	headless?: true;
	/** iOS slim layers, resolved against `WARDEN_SLIM` when the claim runs */
	slim?: SlimLayers;
};

/** Pure rules and shapes of a claim request; the host is only read, never driven. */
export class ClaimRequestRules {
	/** `interactive|high|normal|low` or a non-negative integer. */
	parsePriorityFlag(raw: string): Result<number, WardenError> {
		const parsed = queueOrdering.parsePriority(raw);
		return parsed.success ? parsed : wardenErrors.err("usage", `--priority: ${parsed.error.message}`);
	}

	/** Priority of a claim: `--priority`, else `WARDEN_PRIORITY`, else the command's default, else normal. */
	resolvePriority(
		flags: Pick<ClaimRequest, "priority" | "defaultPriority">,
		env: Record<string, string | undefined>
	): Result<number, WardenError> {
		if (flags.priority !== undefined) return resultFactory.ok(flags.priority);
		const fromEnv = env.WARDEN_PRIORITY?.trim();
		if (fromEnv) {
			const parsed = this.parsePriorityFlag(fromEnv);
			return parsed.success ? parsed : wardenErrors.err("usage", `WARDEN_PRIORITY=${fromEnv}: ${parsed.error.message}`);
		}
		return resultFactory.ok(flags.defaultPriority ?? PRIORITY.normal);
	}

	/** Android `auto` profile → slug of the first AVD. */
	resolveAutoProfile(avds: readonly string[]): Result<string, WardenError> {
		const first = avds[0];
		return first
			? resultFactory.ok(leaseModel.profileSlug(first))
			: wardenErrors.err("not_found", "no Android AVDs found (`emulator -list-avds`) — create one or pass --profile");
	}

	/** Simulator's close setting, shared with every other warden process through the host's store. */
	detachLockFor(host: Pick<LeaseHost, "store" | "pidAlive">): DetachLock {
		return { store: host.store(), pid: process.pid, pidAlive: host.pidAlive };
	}

	/**
	 * The claimed devices this claim had to boot or create: the only ones whose Simulator.app window can
	 * still be on its way. A device that was already running (`reuse`, not booted by the claim) keeps
	 * the window — or the lack of one, when it booted headless — it had.
	 */
	bootedByClaim(outcome: Pick<ClaimOutcome, "claimed">): ClaimedDevice[] {
		return outcome.claimed.filter((c) => c.action !== "reuse" || c.lease.bootedByOwner === true);
	}

	/** JSON shape of claimed devices, shared by `claim` and `run`. */
	claimedJson(outcome: ClaimOutcome) {
		return outcome.claimed.map((c) => ({
			leaseId: c.lease.id,
			platform: c.device.platform,
			udid: c.device.id,
			name: c.device.name,
			action: c.action,
			ttlMs: c.lease.ttlMs,
			...(c.lease.resource.kind === "device" && c.lease.resource.physical
				? { physical: c.lease.resource.physical }
				: {}),
			...(c.lease.label !== undefined ? { label: c.lease.label } : {}),
		}));
	}
}

export const claimRequestRules = new ClaimRequestRules();

export type ClaimHideOptions = {
	/**
	 * Headless iOS: return once the windows are closed and hand the rest of the hide here, instead of
	 * awaiting it. The caller must not use a device in `start.down` before `start.settled` (it is being
	 * booted again), and awaits `settled` before it ends (that puts Simulator's close setting back).
	 */
	onHide?: (start: HideStart) => void;
	/** the platform the hide runs on (tests); defaults to `process.platform` */
	os?: NodeJS.Platform;
	/** polled while the claim waits (queue, pool): true ends it with `claim_aborted` */
	abort?: () => boolean;
	/** the claim's poll sleep (default: `Bun.sleep`); an embedder makes it return early once `abort` turns true */
	sleep?: (ms: number) => Promise<void>;
	/** runs inside the claim transaction that heartbeats the leases (see `ClaimInput.onLeased`) */
	onLeased?: (claimed: readonly ClaimedDevice[]) => void;
	/** the wait between two `lockState` reads while a physical iPhone is locked (tests; default: real time) */
	unlockSleep?: (ms: number) => Promise<void>;
};

/** Runs a device claim over a lease host: auto profile, priority, capacity, then the claim and the sim windows. */
export class ClaimRequestRunner {
	constructor(private readonly host: LeaseHost) {}

	/** `SimWindowHider` deps from the host: problems are `warn` events (scope `headless`); a device the close shut down loses its resident helper. */
	headlessDeps(): HideDeps {
		const { host } = this;
		return {
			exec: host.exec,
			warn: (line) => host.log?.({ kind: "warn", scope: "headless", message: line }),
			onShutDown: host.stopHelper,
			detachLock: claimRequestRules.detachLockFor(host),
		};
	}

	/** Run a device claim with the host's store + provider; iOS claims then tile the sims' windows (headless: close them; see `options.onHide`). */
	async claim(
		owner: Owner,
		flags: ClaimRequest,
		pid: number | undefined,
		options: ClaimHideOptions = {}
	): Promise<ClaimResult> {
		const { host } = this;
		const named = await this.withAutoProfile(flags.request);
		if (!named.success) return named;
		const priority = claimRequestRules.resolvePriority(flags, host.env);
		if (!priority.success) return priority;
		const capacity = await new CapacityDepsBuilder(host).build(owner);
		let request = named.data;
		if (capacity && flags.maxDefaulted) {
			const room = capacityMath.maxConcurrent(request.platform, capacity.budget, capacity.config);
			request = { ...request, max: Math.max(request.max, room) };
		}
		const slim = slimPolicy.resolveSlim({ ...flags.slim, env: host.env });
		if (!slim.success) return wardenErrors.err("usage", slim.error);
		const providerOptions = this.providerOptionsFor(request, slim.data);
		const outcome = await new ClaimService({
			store: host.store(),
			provider: host.providerFor(request.platform, owner, providerOptions),
			...(request.platform === "ios" ? { slim: slim.data !== false } : {}),
			...(host.orphans ? { orphans: host.orphans } : {}),
			owner,
			request,
			ttlMs: flags.ttlMs,
			...(flags.label !== undefined ? { label: flags.label } : {}),
			...(pid !== undefined ? { pid } : {}),
			now: host.now,
			pidAlive: host.pidAlive,
			waitMs: flags.waitMs,
			priority: priority.data,
			...(options.abort ? { abort: options.abort } : {}),
			...(options.sleep ? { sleep: options.sleep } : {}),
			...(options.onLeased ? { onLeased: options.onLeased } : {}),
			...(capacity ? { capacity } : {}),
			log: (line) => host.log?.({ kind: "progress", phase: "claim", message: line }),
		}).claim();
		if (outcome.success && request.platform === "ios") await this.settleIosWindows(outcome.data, flags, options);
		return outcome;
	}

	/** The request with an Android `auto` profile resolved to the first installed AVD that fits. */
	private async withAutoProfile(request: ClaimRequest["request"]): AsyncResult<ClaimRequest["request"], WardenError> {
		const { host } = this;
		const { profile: base, biometrics } = biometricProfiles.split(request.profile);
		if (request.physical || request.platform !== "android" || base !== "auto") return resultFactory.ok(request);
		const avds = await new Adb({ exec: host.exec, env: host.env }).listAvds();
		const profile = avds.success ? claimRequestRules.resolveAutoProfile(avds.data) : avds;
		if (!profile.success) return profile;
		return resultFactory.ok({ ...request, profile: biometricProfiles.profile(profile.data, biometrics) });
	}

	/** The iOS provider options for a claim: its slim profile and whether (and which) physical phones are listed; none for Android. */
	private providerOptionsFor(request: ClaimRequest["request"], slim: SlimProfile | false): ProviderOptions {
		if (request.platform !== "ios") return {};
		return {
			slim,
			physical: request.physical !== undefined,
			...(request.physical?.ids ? { namedPhysical: request.physical.ids } : {}),
		};
	}

	/** After an iOS claim: headless closes the sims' windows (handing the rest to `onHide` when given); otherwise tile them. */
	private async settleIosWindows(outcome: ClaimOutcome, flags: ClaimRequest, options: ClaimHideOptions): Promise<void> {
		const { host } = this;
		const sims = outcome.claimed.map((c) => ({ udid: c.device.id, name: c.device.name }));
		const base = this.headlessDeps();
		const deps = options.os === undefined ? base : { ...base, os: options.os };
		if (flags.headless && options.onHide) options.onHide(await new SimWindowHider(deps).start(sims));
		else if (flags.headless) await new SimWindowHider(deps).hide(sims);
		else {
			const booted = claimRequestRules.bootedByClaim(outcome).map((c) => ({ udid: c.device.id, name: c.device.name }));
			const windowDeps = options.os === undefined ? host : { exec: host.exec, env: host.env, os: options.os };
			const arranger = new SimWindowArranger(windowDeps);
			const opened = await arranger.openDeviceHubWindows(booted);
			await arranger.autoArrange(
				booted.map((s) => s.name),
				opened,
				(missing) => arranger.openDeviceHubWindows(booted.filter((s) => missing.includes(s.name)))
			);
		}
	}
}
