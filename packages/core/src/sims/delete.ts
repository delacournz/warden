/**
 * The one sim delete path, shared by `warden sims prune` and `warden sims delete`. Which sims may go
 * is the caller's call (`rules.ts`); this makes deleting them safe against a concurrent `claim`:
 * each sim is leased to us under the store's `BEGIN IMMEDIATE` (skipped if anyone, live or stale,
 * holds it), shut down if its runtime is still there, `simctl delete`d, forgotten, and released.
 */

import { Simctl } from "@delacour/warden-providers/ios";
import type { Exec } from "@delacour/warden-runtime/exec";
import type { Store } from "@delacour/warden-store/store";
import type { DeviceResource, Lease, Owner } from "@delacour/warden-store/types";

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

export class SimDeleter {
	constructor(private readonly deps: DeleteDeps) {}

	async run<T extends DeleteTarget>(targets: readonly T[], opts: { label: string }): Promise<DeleteResult<T>> {
		const { deps } = this;
		const result: DeleteResult<T> = { removed: [], skipped: [], failed: [] };
		for (const entry of targets) {
			const resource: DeviceResource = { kind: "device", platform: "ios", id: entry.udid, name: entry.name };
			const reservation = this.reserve(resource, opts.label);
			if (reservation.kind === "held") {
				result.skipped.push({ entry, heldBy: reservation.by });
				continue;
			}
			try {
				const deleted = await new Simctl(deps.exec).deleteSim(entry.udid, { shutdown: entry.isAvailable });
				if (!deleted.success) {
					result.failed.push({ entry, error: deleted.error.message });
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

	private reserve(resource: DeviceResource, label: string): Reservation {
		const { deps } = this;
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
}
