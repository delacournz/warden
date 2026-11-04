import type { Exec } from "@delacour/warden-core/exec";
import {
	dueReclaims,
	RECLAIM_LABEL,
	RECLAIM_TTL_MS,
	type ReclaimMode,
	reclaimDevice,
	reclaimFailed,
	reclaimSkipReason,
	reclaimSucceeded,
} from "@delacour/warden-core/reclaim";
import type { Store } from "@delacour/warden-core/store";
import type { DeviceResource, Lease } from "@delacour/warden-core/types";

/** What reclaiming needs from a command/hook context. */
export type ReclaimHost = {
	store: () => Store;
	now: () => number;
	exec: Exec;
	env: Record<string, string | undefined>;
};

/** A released device and the short `reclaiming` lease that holds it meanwhile. */
export type ReclaimHold = { hold: Lease; device: DeviceResource };

/**
 * Inside the release transaction, right after the lease delete: take a `reclaiming` lease (same owner, so the
 * device is never free in between) on every released device warden may reclaim. Devices it must not touch
 * (physical, foreign, golden, quarantined) get a note instead.
 */
export function holdForReclaim(
	store: Store,
	released: readonly Lease[],
	now: number
): { holds: ReclaimHold[]; notes: string[] } {
	const holds: ReclaimHold[] = [];
	const notes: string[] = [];
	for (const lease of released) {
		const device = lease.resource;
		if (device.kind !== "device") continue;
		const skip = reclaimSkipReason(store, device.platform, device.id, device.physical !== undefined);
		if (skip !== undefined) {
			notes.push(skip.startsWith(device.id) ? skip : `${device.id}: ${skip}`);
			continue;
		}
		if (store.findLeaseByResource(device) !== undefined) continue;
		const hold = store.insertLease(
			{ resource: device, owner: lease.owner, ttlMs: RECLAIM_TTL_MS, label: RECLAIM_LABEL, pid: process.pid },
			now
		);
		holds.push({ hold, device });
	}
	return { holds, notes };
}

/**
 * Reclaim each held device (resident helper stopped first), then drop its `reclaiming` lease. A failure
 * quarantines the device (`reclaim: ` reason, retried by `warden gc`) before the lease goes, so no claim
 * slips in between. Returns user-facing notes.
 */
export async function runReclaims(
	host: ReclaimHost,
	holds: readonly ReclaimHold[],
	mode: Exclude<ReclaimMode, "none">,
	stopHelper: (udid: string) => Promise<void>
): Promise<string[]> {
	const store = host.store();
	const deps = { exec: host.exec, store, env: host.env, now: host.now };
	const notes = await Promise.all(
		holds.map(async ({ hold, device }): Promise<string[]> => {
			try {
				await stopHelper(device.id).catch(() => undefined);
				const outcome = await reclaimDevice(deps, device.platform, device.id, mode, device.physical !== undefined);
				if (outcome.kind === "done") {
					reclaimSucceeded(store, device.platform, device.id, host.now());
					return outcome.note === undefined ? [] : [outcome.note];
				}
				if (outcome.kind === "skipped") return [outcome.reason];
				const record = store.listDevices(device.platform).find((d) => d.id === device.id);
				if (record === undefined) return [`reclaim of ${device.id} failed: ${outcome.error}`];
				const state = reclaimFailed(store, record, mode, outcome.error, host.now());
				return [
					`reclaim of ${device.name} (${device.id}) failed (try ${state.tries}): ${outcome.error}; quarantined (clear with: warden sim unquarantine ${device.id})`,
				];
			} finally {
				store.deleteLeases([hold.id]);
			}
		})
	);
	return notes.flat();
}

/**
 * `warden gc`'s retry of failed reclaims: each reclaim-quarantined device whose backoff has elapsed and that nobody
 * leases gets a `reclaiming` lease and one more try (see `reclaimFailed` for the schedule). Success lifts the
 * quarantine; the last failed try leaves it in place with its reason until `warden sim unquarantine`.
 */
export async function retryDueReclaims(
	host: ReclaimHost,
	owner: Lease["owner"],
	stopHelper: (udid: string) => Promise<void>
): Promise<string[]> {
	const store = host.store();
	const byMode = new Map<Exclude<ReclaimMode, "none">, ReclaimHold[]>();
	store.transaction(() => {
		const now = host.now();
		for (const { record, mode } of dueReclaims(store, now)) {
			const device: DeviceResource = { kind: "device", platform: record.platform, id: record.id, name: record.name };
			if (store.findLeaseByResource(device) !== undefined) continue;
			const hold = store.insertLease(
				{ resource: device, owner, ttlMs: RECLAIM_TTL_MS, label: RECLAIM_LABEL, pid: process.pid },
				now
			);
			byMode.set(mode, [...(byMode.get(mode) ?? []), { hold, device }]);
		}
	});
	const notes = await Promise.all([...byMode].map(([mode, group]) => runReclaims(host, group, mode, stopHelper)));
	return notes.flat();
}
