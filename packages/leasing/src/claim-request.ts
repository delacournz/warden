import type { SlimProfile } from "@delacour/warden-config/slim.profile";
import { resolveSlim, type SlimSetting } from "@delacour/warden-config/slim-policy";
import { listAvds } from "@delacour/warden-providers/android";
import { biometricProfile, splitBiometricProfile } from "@delacour/warden-providers/biometrics";
import type { DeviceRequest, Owner } from "@delacour/warden-store/types";
import { leaseModel } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { maxConcurrent } from "./capacity";
import { buildCapacityDeps } from "./capacity-deps";
import { type ClaimedDevice, type ClaimOutcome, type ClaimResult, claimDevices } from "./claim";
import type { LeaseHost, ProviderOptions } from "./lease-host";
import { PRIORITY, parsePriority } from "./queue";
import {
	autoArrangeSimWindows,
	type DetachLock,
	type HideDeps,
	type HideStart,
	hideSimWindows,
	openDeviceHubWindows,
	startHideSimWindows,
} from "./sim-windows";

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

/** `interactive|high|normal|low` or a non-negative integer. */
export function parsePriorityFlag(raw: string): Result<number, WardenError> {
	const parsed = parsePriority(raw);
	return parsed.success ? parsed : wardenErrors.err("usage", `--priority: ${parsed.error.message}`);
}

/** Priority of a claim: `--priority`, else `WARDEN_PRIORITY`, else the command's default, else normal. */
export function resolvePriority(
	flags: Pick<ClaimRequest, "priority" | "defaultPriority">,
	env: Record<string, string | undefined>
): Result<number, WardenError> {
	if (flags.priority !== undefined) return resultFactory.ok(flags.priority);
	const fromEnv = env.WARDEN_PRIORITY?.trim();
	if (fromEnv) {
		const parsed = parsePriorityFlag(fromEnv);
		return parsed.success ? parsed : wardenErrors.err("usage", `WARDEN_PRIORITY=${fromEnv}: ${parsed.error.message}`);
	}
	return resultFactory.ok(flags.defaultPriority ?? PRIORITY.normal);
}

/** Android `auto` profile → slug of the first AVD. */
export function resolveAutoProfile(avds: readonly string[]): Result<string, WardenError> {
	const first = avds[0];
	return first
		? resultFactory.ok(leaseModel.profileSlug(first))
		: wardenErrors.err("not_found", "no Android AVDs found (`emulator -list-avds`) — create one or pass --profile");
}

/** Simulator's close setting, shared with every other warden process through the host's store. */
export function detachLockFor(host: Pick<LeaseHost, "store" | "pidAlive">): DetachLock {
	return { store: host.store(), pid: process.pid, pidAlive: host.pidAlive };
}

/** `hideSimWindows` deps from a host: problems are `warn` events (scope `headless`); a device the close shut down loses its resident helper. */
export function headlessDeps(host: LeaseHost): HideDeps {
	return {
		exec: host.exec,
		warn: (line) => host.log?.({ kind: "warn", scope: "headless", message: line }),
		onShutDown: host.stopHelper,
		detachLock: detachLockFor(host),
	};
}

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

/**
 * The claimed devices this claim had to boot or create: the only ones whose Simulator.app window can
 * still be on its way. A device that was already running (`reuse`, not booted by the claim) keeps
 * the window — or the lack of one, when it booted headless — it had.
 */
export function bootedByClaim(outcome: Pick<ClaimOutcome, "claimed">): ClaimedDevice[] {
	return outcome.claimed.filter((c) => c.action !== "reuse" || c.lease.bootedByOwner === true);
}

/** The request with an Android `auto` profile resolved to the first installed AVD that fits. */
async function withAutoProfile(
	host: LeaseHost,
	request: ClaimRequest["request"]
): AsyncResult<ClaimRequest["request"], WardenError> {
	const { profile: base, biometrics } = splitBiometricProfile(request.profile);
	if (request.physical || request.platform !== "android" || base !== "auto") return resultFactory.ok(request);
	const avds = await listAvds({ exec: host.exec, env: host.env });
	const profile = avds.success ? resolveAutoProfile(avds.data) : avds;
	if (!profile.success) return profile;
	return resultFactory.ok({ ...request, profile: biometricProfile(profile.data, biometrics) });
}

/** The iOS provider options for a claim: its slim profile and whether (and which) physical phones are listed; none for Android. */
function providerOptionsFor(request: ClaimRequest["request"], slim: SlimProfile | false): ProviderOptions {
	if (request.platform !== "ios") return {};
	return {
		slim,
		physical: request.physical !== undefined,
		...(request.physical?.ids ? { namedPhysical: request.physical.ids } : {}),
	};
}

/** Run a device claim with the host's store + provider; iOS claims then tile the sims' windows (headless: close them; see `options.onHide`). */
export async function claimWithRequest(
	host: LeaseHost,
	owner: Owner,
	flags: ClaimRequest,
	pid: number | undefined,
	options: ClaimHideOptions = {}
): Promise<ClaimResult> {
	const named = await withAutoProfile(host, flags.request);
	if (!named.success) return named;
	const priority = resolvePriority(flags, host.env);
	if (!priority.success) return priority;
	const capacity = await buildCapacityDeps(host, owner);
	let request = named.data;
	if (capacity && flags.maxDefaulted) {
		const room = maxConcurrent(request.platform, capacity.budget, capacity.config);
		request = { ...request, max: Math.max(request.max, room) };
	}
	const slim = resolveSlim({ ...flags.slim, env: host.env });
	if (!slim.success) return wardenErrors.err("usage", slim.error);
	const providerOptions = providerOptionsFor(request, slim.data);
	const outcome = await claimDevices({
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
	});
	if (outcome.success && request.platform === "ios") await settleIosWindows(host, outcome.data, flags, options);
	return outcome;
}

/** After an iOS claim: headless closes the sims' windows (handing the rest to `onHide` when given); otherwise tile them. */
async function settleIosWindows(
	host: LeaseHost,
	outcome: ClaimOutcome,
	flags: ClaimRequest,
	options: ClaimHideOptions
): Promise<void> {
	const sims = outcome.claimed.map((c) => ({ udid: c.device.id, name: c.device.name }));
	const deps = options.os === undefined ? headlessDeps(host) : { ...headlessDeps(host), os: options.os };
	if (flags.headless && options.onHide) options.onHide(await startHideSimWindows(deps, sims));
	else if (flags.headless) await hideSimWindows(deps, sims);
	else {
		const booted = bootedByClaim(outcome).map((c) => ({ udid: c.device.id, name: c.device.name }));
		const windowDeps = options.os === undefined ? host : { exec: host.exec, env: host.env, os: options.os };
		const opened = await openDeviceHubWindows(windowDeps, booted);
		await autoArrangeSimWindows(
			windowDeps,
			booted.map((s) => s.name),
			opened,
			(missing) =>
				openDeviceHubWindows(
					windowDeps,
					booted.filter((s) => missing.includes(s.name))
				)
		);
	}
}

/** JSON shape of claimed devices, shared by `claim` and `run`. */
export function claimedJson(outcome: ClaimOutcome) {
	return outcome.claimed.map((c) => ({
		leaseId: c.lease.id,
		platform: c.device.platform,
		udid: c.device.id,
		name: c.device.name,
		action: c.action,
		ttlMs: c.lease.ttlMs,
		...(c.lease.resource.kind === "device" && c.lease.resource.physical ? { physical: c.lease.resource.physical } : {}),
		...(c.lease.label !== undefined ? { label: c.lease.label } : {}),
	}));
}
