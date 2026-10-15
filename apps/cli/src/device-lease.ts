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

/** Why a caller may not use a device: someone else holds it (`device_foreign`) or nobody does (`device_not_leased`). */
export type DeviceLeaseError = { code: "device_foreign" | "device_not_leased"; message: string };

/** `own` = already the caller's (heartbeat); `reclaimed` = a stale lease was replaced; `leased` = was free. */
export type CallerLease = { lease: Lease; action: "own" | "reclaimed" | "leased" };

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
};

/** Message shown to the model/user when a device is held by someone else. */
export function blockMessage(id: string, platform: Platform, owner: Owner): string {
	const where = ownerLocation(owner);
	const noun = platform === "ios" ? "udid" : "serial";
	return `device ${id} leased by ${describeOwner(owner)}${where ? ` (${where})` : ""} — run \`warden claim ${platform}\` and use the returned ${noun}`;
}

/**
 * The one lease check for a caller using a device (the PreToolUse hook and `warden ui`), atomically:
 * own lease → heartbeat; another live owner → `device_foreign`; stale or missing → taken over when
 * `claim`, else `device_not_leased`.
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
		if (existing && sameOwner(existing.owner, owner)) {
			store.heartbeat([existing.id], opts.now);
			return ok({ lease: { ...existing, heartbeatAt: opts.now }, action: "own" });
		}
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

function insertCallerLease(store: Store, owner: Owner, probe: DeviceResource, opts: EnsureLeaseOptions): Lease {
	const known = store.listDevices(probe.platform).find((d) => d.id === probe.id);
	return store.insertLease(
		{
			resource: { ...probe, name: opts.name ?? known?.name ?? probe.id },
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
