/**
 * The one sim delete path, shared by `warden sims prune` and `warden sims delete`. Which sims may go
 * is the caller's call (`rules.ts`); this makes deleting them safe against a concurrent `claim`:
 * each sim is leased to us under the store's `BEGIN IMMEDIATE` (skipped if anyone, live or stale,
 * holds it), shut down if its runtime is still there, `simctl delete`d, forgotten, and released.
 */

import type { Exec } from "../exec";
import { deleteSim } from "../providers/ios";
import type { Store } from "../store";
import type { DeviceResource, Lease, Owner } from "../types";

export type DeleteDeps = {
	exec: Exec;
	store: Store;
	owner: Owner;
	/** pid recorded on the delete lease */
	pid: number;
	now: () => number;
};

export type DeleteTarget = { udid: string; name: string; isAvailable: boolean };

export type DeleteResult<T extends DeleteTarget> = {
	removed: T[];
	/** someone (live or stale) holds a lease on it */
	skipped: Array<{ entry: T; heldBy: Owner }>;
	failed: Array<{ entry: T; error: string }>;
};

/** held while a sim is deleted so a concurrent `warden claim` can't lease it mid-delete */
const DELETE_LEASE_TTL_MS = 10 * 60_000;

type Reservation = { kind: "ours"; lease: Lease } | { kind: "held"; by: Owner };

function reserve(deps: DeleteDeps, resource: DeviceResource, label: string): Reservation {
	const { store } = deps;
	return store.transaction((): Reservation => {
		const held = store.findLeaseByResource(resource);
		if (held) return { kind: "held", by: held.owner };
		const lease = store.insertLease(
			{ resource, owner: deps.owner, ttlMs: DELETE_LEASE_TTL_MS, pid: deps.pid, label },
			deps.now()
		);
		return { kind: "ours", lease };
	});
}

export async function deleteSims<T extends DeleteTarget>(
	deps: DeleteDeps,
	targets: readonly T[],
	opts: { label: string }
): Promise<DeleteResult<T>> {
	const result: DeleteResult<T> = { removed: [], skipped: [], failed: [] };
	for (const entry of targets) {
		const resource: DeviceResource = { kind: "device", platform: "ios", id: entry.udid, name: entry.name };
		const reservation = reserve(deps, resource, opts.label);
		if (reservation.kind === "held") {
			result.skipped.push({ entry, heldBy: reservation.by });
			continue;
		}
		try {
			const deleted = await deleteSim(deps.exec, entry.udid, { shutdown: entry.isAvailable });
			if (!deleted.success) {
				result.failed.push({ entry, error: deleted.error });
				continue;
			}
			deps.store.forgetDevice("ios", entry.udid);
			result.removed.push(entry);
		} finally {
			deps.store.deleteLeases([reservation.lease.id]);
		}
	}
	return result;
}
