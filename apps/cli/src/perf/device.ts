import { isLeaseAlive, type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { describeOwner, type Lease, type Owner, type Platform, sameOwner } from "@delacour/warden-core/types";
import { ok, type Result } from "@delacour/warden-types/result";
import type { UiDeviceFlags, UiDeviceSource } from "../agent-ui/device";
import { type UiDeviceInfo, type UiError, uiError } from "../agent-ui/output";
import { leasePidFor, parsePlatform, resolveOwner } from "../claim-flags";
import type { CommandContext } from "../context";
import { ensureCallerLease } from "../device-lease";
import { deviceTarget } from "../hooks/claude-pretool";

/** Label on the leases `warden perf --claim` creates. */
export const PERF_LEASE_LABEL = "warden perf";

/**
 * `observe` capturers (metrics, attach-only traces, Metro/Hermes, logs, crashes, frame reads) run on any warden
 * device and never take or heartbeat a lease. `mutate` ones (kill/launch, dumpheap, `gfxinfo reset`, heap
 * snapshots) need the caller's own lease.
 */
export type PerfMode = "observe" | "mutate";

export type PerfDeviceFlags = UiDeviceFlags & {
	/** mutate a device someone else holds (refused while a live warden process holds the lease) */
	allowMutateForeign?: boolean;
};

export type PerfTarget = UiDeviceInfo & {
	/** who holds the device now (live lease), when not the caller */
	holder?: string;
	ownedByCaller: boolean;
	/** the caller's lease, when `mutate` took or kept one */
	lease?: Lease;
	source: UiDeviceSource | "booted";
	mode: PerfMode;
};

export type BootedDevice = { platform: Platform; id: string; name: string };

/** A device `perf ls --devices` and an `ambiguous_device` error list. */
export type PerfCandidate = { udid: string; platform: Platform; name: string; holder?: string; app?: string };

/** What device resolution reaches the machine through; tests inject fakes. */
export type PerfDeviceDeps = {
	pidAlive: PidAlive;
	/** every booted device on the host (warden's or not: the store decides which are ours) */
	booted: (ctx: CommandContext) => Promise<readonly BootedDevice[]>;
	/** the app in the foreground, for listing candidates (best effort) */
	foregroundApp: (ctx: CommandContext, device: BootedDevice) => Promise<string | undefined>;
};

export const defaultPerfDeviceDeps: PerfDeviceDeps = {
	pidAlive: processAlive,
	booted: async (ctx) => {
		const { providerFor } = await import("../providers");
		const owner = resolveOwner(ctx);
		const inventories = await Promise.all(
			(["ios", "android"] as const).map((platform) => providerFor(platform, ctx, owner).inventory())
		);
		return inventories.flatMap((inventory) =>
			inventory.success
				? inventory.data
						.filter((d) => d.state === "booted" && d.golden !== true)
						.map(({ platform, id, name }) => ({ platform, id, name }))
				: []
		);
	},
	foregroundApp: async (ctx, device) => {
		const { foregroundApp } = await import("./app");
		return foregroundApp(ctx, device);
	},
};

type Named = { id: string; platform?: Platform; source: UiDeviceSource | "booted" };

function fail(error: UiError): { success: false; error: UiError } {
	return { success: false, error };
}

function named(ctx: CommandContext, flags: PerfDeviceFlags): Result<Named | undefined, UiError> {
	if (flags.lease !== undefined) {
		const lease = ctx.store().getLease(flags.lease);
		if (!lease) return fail(uiError("lease_not_found", `no lease ${flags.lease}`, { hint: "see warden ls" }));
		if (lease.resource.kind !== "device") return fail(uiError("usage", `lease ${flags.lease} is not a device lease`));
		return ok({ id: lease.resource.id, platform: lease.resource.platform, source: "flag" });
	}
	if (flags.serial !== undefined) return ok({ id: flags.serial, platform: "android", source: "flag" });
	if (flags.udid !== undefined) return ok({ id: flags.udid, source: "flag" });
	const single = ctx.env.WARDEN_UDID?.trim();
	if (single) return ok({ id: single, source: "WARDEN_UDID" });
	const many = (ctx.env.WARDEN_UDIDS ?? "").split(/[\s,]+/).filter((s) => s.length > 0);
	const only = many.length === 1 ? many[0] : undefined;
	return ok(only === undefined ? undefined : { id: only, source: "WARDEN_UDIDS" });
}

type Known = { platform: Platform; id: string; name: string };

/** Devices warden knows: created or adopted (`devices` table) plus anything leased. */
function knownDevices(ctx: CommandContext): Known[] {
	const store = ctx.store();
	const byKey = new Map<string, Known>();
	for (const d of store.listDevices())
		byKey.set(`${d.platform}:${d.id}`, { platform: d.platform, id: d.id, name: d.name });
	for (const l of store.listLeases()) {
		if (l.resource.kind === "device") {
			const { platform, id, name } = l.resource;
			byKey.set(`${platform}:${id}`, { platform, id, name });
		}
	}
	return [...byKey.values()];
}

function liveLease(ctx: CommandContext, deps: PerfDeviceDeps, platform: Platform, id: string): Lease | undefined {
	const lease = ctx.store().findLeaseByResource({ kind: "device", platform, id, name: id });
	return lease && isLeaseAlive(lease, ctx.now(), deps.pidAlive) ? lease : undefined;
}

function holderOf(lease: Lease | undefined, owner: Owner): string | undefined {
	if (lease === undefined || sameOwner(lease.owner, owner)) return undefined;
	return `${describeOwner(lease.owner)}${lease.label ? ` (${lease.label})` : ""}`;
}

/** Booted devices that are warden's (known to the store), optionally of one platform. */
async function bootedKnown(
	ctx: CommandContext,
	deps: PerfDeviceDeps,
	platform: Platform | undefined
): Promise<Known[]> {
	const known = new Set(knownDevices(ctx).map((d) => `${d.platform}:${d.id}`));
	const booted = await deps.booted(ctx);
	return booted.filter(
		(d) => known.has(`${d.platform}:${d.id}`) && (platform === undefined || d.platform === platform)
	);
}

async function candidatesOf(
	ctx: CommandContext,
	deps: PerfDeviceDeps,
	owner: Owner,
	devices: readonly Known[]
): Promise<PerfCandidate[]> {
	return Promise.all(
		devices.map(async (d) => {
			const holder = holderOf(liveLease(ctx, deps, d.platform, d.id), owner);
			const app = await deps.foregroundApp(ctx, d).catch(() => undefined);
			return {
				udid: d.id,
				platform: d.platform,
				name: d.name,
				...(holder !== undefined ? { holder } : {}),
				...(app !== undefined ? { app } : {}),
			};
		})
	);
}

/** Warden's booted devices with who holds each and its foreground app (`perf ls --devices`). */
export async function listPerfCandidates(
	ctx: CommandContext,
	deps: PerfDeviceDeps,
	platform?: Platform
): Promise<PerfCandidate[]> {
	return candidatesOf(ctx, deps, resolveOwner(ctx), await bootedKnown(ctx, deps, platform));
}

function ambiguous(what: string, candidates: readonly PerfCandidate[]): UiError {
	const listing = candidates.map((c) => `${c.udid} (${c.name})`).join(", ");
	return uiError("ambiguous_device", `${what}: ${listing}`, {
		hint: "pick one with --udid <id> (or --serial / --lease); warden perf ls --devices lists them",
		details: { candidates },
	});
}

/** Which device, when no flag or env names one: the caller's single lease, else the only booted warden device. */
async function pick(
	ctx: CommandContext,
	deps: PerfDeviceDeps,
	owner: Owner,
	flags: PerfDeviceFlags,
	platform: Platform | undefined
): Promise<Result<Named, UiError>> {
	const mine = ctx
		.store()
		.listLeasesByOwner(owner)
		.flatMap((l) =>
			l.resource.kind === "device" && (platform === undefined || l.resource.platform === platform) ? [l.resource] : []
		);
	if (mine.length > 1) {
		return fail(ambiguous("several devices leased", await candidatesOf(ctx, deps, owner, mine)));
	}
	const first = mine[0];
	if (first) return ok({ id: first.id, platform: first.platform, source: "lease" });
	const booted = await bootedKnown(ctx, deps, platform);
	if (booted.length > 1)
		return fail(ambiguous("several booted warden devices", await candidatesOf(ctx, deps, owner, booted)));
	const only = booted[0];
	if (only) return ok({ id: only.id, platform: only.platform, source: "booted" });
	return fail(
		uiError("no_device_leased", "no booted warden device", {
			hint: `run warden claim ${flags.platform ?? "ios"} --json, or add --claim to a mutating command`,
		})
	);
}

function platformOf(ctx: CommandContext, id: string): Platform | undefined {
	const known = knownDevices(ctx).find((d) => d.id === id);
	if (known) return known.platform;
	return undefined;
}

/** `mutate`: the caller's own lease (heartbeat or `--claim`), or `--allow-mutate-foreign` onto a device no live warden process holds. */
function leaseForMutation(
	ctx: CommandContext,
	deps: PerfDeviceDeps,
	owner: Owner,
	flags: PerfDeviceFlags,
	device: Known
): Result<{ lease?: Lease; ownedByCaller: boolean }, UiError> {
	const pid = leasePidFor(owner);
	const leased = ensureCallerLease(ctx.store(), owner, device.platform, device.id, {
		now: ctx.now(),
		pidAlive: deps.pidAlive,
		claim: flags.claim === true,
		label: PERF_LEASE_LABEL,
		name: device.name,
		...(pid !== undefined ? { pid } : {}),
		exclusive: flags.force !== true,
	});
	if (leased.success) return ok({ lease: leased.data.lease, ownedByCaller: true });
	const { code, message } = leased.error;
	if (code === "device_busy") return fail(uiError("device_busy", message));
	if (flags.allowMutateForeign === true) {
		const held = liveLease(ctx, deps, device.platform, device.id);
		if (held?.pid !== undefined && deps.pidAlive(held.pid)) {
			return fail(
				uiError("device_busy", `${message} — a live warden process (pid ${held.pid}) holds it; not mutating it`)
			);
		}
		return ok({ ownedByCaller: false });
	}
	return fail(
		uiError(code, message, {
			hint: "add --claim to lease a free device, or --allow-mutate-foreign to act on one someone else holds",
		})
	);
}

/**
 * The device a `warden perf` call acts on. Order: `--udid|--serial|--lease` → `WARDEN_UDID` → `WARDEN_UDIDS` (if one)
 * → the caller's own single device lease → the only booted device warden knows (several: `ambiguous_device`, listed).
 * A device warden does not know is `device_unknown` (foreign = read-only: perf attaches only to warden's own).
 * `observe` never takes or heartbeats a lease and reports who holds the device; `mutate` needs the caller's lease.
 */
export async function resolvePerfDevice(
	ctx: CommandContext,
	flags: PerfDeviceFlags,
	mode: PerfMode,
	deps: PerfDeviceDeps = defaultPerfDeviceDeps
): Promise<Result<PerfTarget, UiError>> {
	const owner = resolveOwner(ctx);
	const explicit = named(ctx, flags);
	if (!explicit.success) return explicit;
	const platformFlag = flags.platform === undefined ? undefined : parsePlatform(flags.platform);
	if (platformFlag && !platformFlag.success) return fail(uiError("usage", platformFlag.error));
	let picked: Named;
	if (explicit.data !== undefined) {
		picked = explicit.data;
	} else {
		const found = await pick(ctx, deps, owner, flags, platformFlag?.data);
		if (!found.success) return found;
		picked = found.data;
	}
	const platform = picked.platform ?? platformOf(ctx, picked.id);
	const device =
		platform === undefined ? undefined : knownDevices(ctx).find((d) => d.platform === platform && d.id === picked.id);
	if (device === undefined) {
		const shape = deviceTarget(picked.id);
		const hint =
			shape.kind === "device"
				? "warden perf only attaches to devices warden created or leased; see warden devices"
				: undefined;
		return fail(
			uiError("device_unknown", `${picked.id} is not a device warden knows`, hint === undefined ? {} : { hint })
		);
	}
	const lease = liveLease(ctx, deps, device.platform, device.id);
	const holder = holderOf(lease, owner);
	const base = {
		udid: device.id,
		platform: device.platform,
		name: device.name,
		...(holder !== undefined ? { holder } : {}),
		source: picked.source,
		mode,
	} as const;
	if (mode === "observe") {
		return ok({ ...base, ownedByCaller: lease !== undefined && sameOwner(lease.owner, owner) });
	}
	const mutable = leaseForMutation(ctx, deps, owner, flags, device);
	if (!mutable.success) return mutable;
	return ok({
		...base,
		ownedByCaller: mutable.data.ownedByCaller,
		...(mutable.data.lease ? { lease: mutable.data.lease } : {}),
	});
}
