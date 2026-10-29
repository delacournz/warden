import { DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { isLeaseAlive, type PidAlive } from "@delacour/warden-core/liveness";
import type { Store } from "@delacour/warden-core/store";
import {
	type DeviceResource,
	describeOwner,
	type Lease,
	type Owner,
	ownerLocation,
	type Platform,
	sameOwner,
} from "@delacour/warden-core/types";
import { ok, type Result } from "@delacour/warden-types/result";

/**
 * Why a caller may not use a device: someone else holds it (`device_foreign`), a live warden process holds the
 * caller's own lease (`device_busy`, only for `exclusive` callers) or nobody does (`device_not_leased`).
 */
export type DeviceLeaseError = { code: "device_foreign" | "device_busy" | "device_not_leased"; message: string };

/**
 * `own` = already the caller's (heartbeat); `attached` = the caller's shared lease a live `warden dev` holds (used
 * beside it: no heartbeat, never released by the caller); `reclaimed` = a stale lease was replaced; `leased` = was free.
 */
export type CallerLease = { lease: Lease; action: "own" | "attached" | "reclaimed" | "leased" };

export type EnsureLeaseOptions = {
	now: number;
	pidAlive: PidAlive;
	/** false: only an own lease passes; true: a stale or missing lease is taken over */
	claim: boolean;
	label: string;
	/** device name stored on a new lease (default: the device record's name, else the id) */
	name?: string;
	/** lease liveness pid (user owners: their shell) */
	pid?: number;
	/** the caller is about to boot the device — theirs to shut down on release */
	bootedByOwner?: boolean;
	ttlMs?: number;
	/**
	 * Refuse an own lease whose `pid` is a live process other than `pid` (a running `warden e2e` / `batch` /
	 * `run` holds it) with `device_busy`. `warden ui` sets it unless `--force`; the hook does not. A `shared` lease
	 * (`warden dev`) is never busy: the caller attaches to it, exclusive or not.
	 */
	exclusive?: boolean;
	/** a real phone: stamped on a lease this call creates (an existing lease keeps what it has) */
	physical?: DeviceResource["physical"];
};

/** Message shown to the model/user when a device is held by someone else. */
export function blockMessage(id: string, platform: Platform, owner: Owner): string {
	const where = ownerLocation(owner);
	const noun = platform === "ios" ? "udid" : "serial";
	return `device ${id} leased by ${describeOwner(owner)}${where ? ` (${where})` : ""} — run \`warden claim ${platform}\` and use the returned ${noun}`;
}

/** Message for `device_busy`: who holds the device, the holding pid and the lease label. */
export function busyMessage(lease: Lease): string {
	const name = lease.resource.kind === "device" ? lease.resource.name : undefined;
	const id = lease.resource.kind === "device" ? lease.resource.id : lease.id;
	const holder = [`pid ${lease.pid}`, lease.label].filter((part): part is string => Boolean(part)).join(", ");
	const device = name && name !== id ? `${name} (${id})` : id;
	return `device ${device} is in use by ${describeOwner(lease.owner)} (${holder}); re-run with --force to drive it anyway`;
}

/** An own lease another live process holds: its pid is set, is not the caller's liveness pid, and is alive. */
function heldByOtherProcess(lease: Lease, opts: EnsureLeaseOptions): boolean {
	return lease.pid !== undefined && lease.pid !== opts.pid && opts.pidAlive(lease.pid);
}

/**
 * The one lease check for a caller using a device (`warden ui`), atomically:
 * own lease → heartbeat (with `exclusive`, one a live warden process holds → `device_busy`; a shared
 * `warden dev` lease → `attached`); another live owner → `device_foreign`; stale or missing → taken over when `claim`, else `device_not_leased`.
 */
export function ensureCallerLease(
	store: Store,
	owner: Owner,
	platform: Platform,
	id: string,
	opts: EnsureLeaseOptions
): Result<CallerLease, DeviceLeaseError> {
	const probe: DeviceResource = { kind: "device", platform, id, name: opts.name ?? id };
	return store.transaction((): Result<CallerLease, DeviceLeaseError> => {
		const existing = store.findLeaseByResource(probe);
		if (existing && sameOwner(existing.owner, owner)) return ownLease(store, existing, opts);
		if (existing && isLeaseAlive(existing, opts.now, opts.pidAlive)) {
			return { success: false, error: { code: "device_foreign", message: blockMessage(id, platform, existing.owner) } };
		}
		if (!opts.claim) {
			return {
				success: false,
				error: {
					code: "device_not_leased",
					message: existing
						? `device ${id} has a stale lease (${describeOwner(existing.owner)})`
						: `device ${id} is not leased`,
				},
			};
		}
		if (existing) store.deleteLeases([existing.id]);
		return ok({ lease: insertCallerLease(store, owner, probe, opts), action: existing ? "reclaimed" : "leased" });
	});
}

/**
 * The caller's own lease. Held by another live process: shared (`warden dev`) → `attached` (its holder keeps the
 * heartbeat), else with `exclusive` → `device_busy`. Otherwise heartbeat it.
 */
function ownLease(store: Store, existing: Lease, opts: EnsureLeaseOptions): Result<CallerLease, DeviceLeaseError> {
	const held = heldByOtherProcess(existing, opts);
	if (held && existing.shared) return ok({ lease: existing, action: "attached" });
	if (opts.exclusive && held) {
		return { success: false, error: { code: "device_busy", message: busyMessage(existing) } };
	}
	store.heartbeat([existing.id], opts.now);
	return ok({ lease: { ...existing, heartbeatAt: opts.now }, action: "own" });
}

function insertCallerLease(store: Store, owner: Owner, probe: DeviceResource, opts: EnsureLeaseOptions): Lease {
	const known = store.listDevices(probe.platform).find((d) => d.id === probe.id);
	return store.insertLease(
		{
			resource: {
				...probe,
				name: opts.name ?? known?.name ?? probe.id,
				...(opts.physical !== undefined ? { physical: opts.physical } : {}),
			},
			owner,
			ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
			label: opts.label,
			...(opts.pid !== undefined ? { pid: opts.pid } : {}),
			...(opts.bootedByOwner ? { bootedByOwner: true } : {}),
		},
		opts.now
	);
}

/** What `releaseDevices` needs from a command/hook context. */
export type ReleaseHost = { store: () => Store; now: () => number };

export type ReleaseOptions = {
	/** runs per released device lease after it is deleted (teardown hook; failures are swallowed) */
	after?: ((udid: string) => Promise<void>) | undefined;
	/** mark the devices used now (default true; gc/cleanup paths pass false) */
	touch?: boolean;
	/** re-checked inside the transaction: leases it rejects are left alone (gc: still stale?) */
	only?: (lease: Lease) => boolean;
};

/**
 * The single CLI choke point for deleting leases (devices, ports …). The delete happens
 * synchronously, before the first await; `after` then runs per device lease. Unknown ids are
 * skipped. Returns the leases that existed.
 */
export async function releaseDevices(
	host: ReleaseHost,
	leaseIds: readonly string[],
	opts: ReleaseOptions = {}
): Promise<Lease[]> {
	const store = host.store();
	const leases = store.transaction(() => {
		const found = leaseIds.flatMap((id) => store.getLease(id) ?? []).filter((l) => opts.only?.(l) ?? true);
		store.deleteLeases(found.map((l) => l.id));
		if (opts.touch !== false) {
			const now = host.now();
			for (const l of found)
				if (l.resource.kind === "device") store.touchDevice(l.resource.platform, l.resource.id, now);
		}
		return found;
	});
	const after = opts.after;
	if (after) {
		await Promise.all(
			leases.flatMap((l) =>
				l.resource.kind === "device"
					? [
							Promise.resolve(l.resource.id)
								.then(after)
								.catch(() => undefined),
						]
					: []
			)
		);
	}
	return leases;
}
