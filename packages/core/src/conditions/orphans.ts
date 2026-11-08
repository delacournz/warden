import type { Exec } from "../exec";
import type { PidAlive } from "../liveness";
import type { Store } from "../store";
import type { Platform } from "../types";
import { type ConditionRow, toConditionRecord } from "./conditions";
import type { ConditionArea, ConditionRecord } from "./conditions.types";
import type { UndoDeps } from "./undo";

/**
 * Conditions whose lease was deleted without `releaseDevices` undoing them first (stale reclaim in a
 * claim, eviction, rollback, an older `warden` binary): a database trigger parks them in
 * `orphan_conditions`. They are undone before the device is leased again, or by gc when it is unleased.
 */
export type Orphan = { leaseId: string; record: ConditionRecord };

type OrphanRow = ConditionRow & { lease_id: string };

/** The orphaned conditions of one device (a cheap read: no exec). */
export function orphanConditions(store: Store, platform: Platform, deviceId: string): Orphan[] {
	return store.db
		.query<OrphanRow, [string, string]>(
			"SELECT area, json, owned, set_at, lease_id FROM orphan_conditions WHERE platform = ? AND device_id = ?"
		)
		.all(platform, deviceId)
		.map((row) => ({ leaseId: row.lease_id, record: toConditionRecord(row) }));
}

/** Every device that has orphans (gc). */
export function orphanedDevices(store: Store): { platform: Platform; id: string }[] {
	return store.db
		.query<{ platform: Platform; id: string }, []>(
			"SELECT DISTINCT platform, device_id AS id FROM orphan_conditions ORDER BY platform, device_id"
		)
		.all();
}

function forget(store: Store, platform: Platform, deviceId: string, area: ConditionArea): void {
	store.db
		.query("DELETE FROM orphan_conditions WHERE platform = ? AND device_id = ? AND area = ?")
		.run(platform, deviceId, area);
}

export type OrphanUndoReport = { reset: ConditionArea[]; errors: string[] };

/**
 * Undo `device`'s orphaned conditions with the same resets as a live lease's undo. Each orphan whose
 * reset succeeded is deleted; a failed one stays for the next try. Idempotent and never throws. Only
 * call it on a device about to be leased by the caller, or one nobody holds.
 */
export async function undoOrphans(
	deps: UndoDeps,
	device: { platform: Platform; id: string }
): Promise<OrphanUndoReport> {
	const report: OrphanUndoReport = { reset: [], errors: [] };
	// imported here so the cheap readers above stay light for claim / gc when nothing is orphaned
	const { resetRecord } = await import("./undo");
	for (const { leaseId, record } of orphanConditions(deps.store, device.platform, device.id)) {
		const { failures } = await resetRecord(deps, device, leaseId, record);
		if (failures.length > 0) {
			report.errors.push(...failures.map((f) => `${record.area}: ${f}`));
			continue;
		}
		forget(deps.store, device.platform, device.id, record.area);
		report.reset.push(record.area);
	}
	return report;
}

/** What a claim or gc needs to undo orphans; the clock and liveness default to the real ones. */
export type OrphanHost = {
	exec: Exec;
	env: Record<string, string | undefined>;
	now?: () => number;
	pidAlive?: PidAlive;
	kill?: (pid: number) => void;
};

/** `undoOrphans` wired to a host: real kill / liveness and a proxy releaser that imports its module only for a network orphan. */
export async function undoOrphansWith(
	store: Store,
	host: OrphanHost,
	device: { platform: Platform; id: string }
): Promise<OrphanUndoReport> {
	const { processAlive } = await import("../liveness");
	const pidAlive = host.pidAlive ?? processAlive;
	const kill = host.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
	return undoOrphans(
		{
			store,
			exec: host.exec,
			env: host.env,
			now: host.now ?? Date.now,
			pidAlive,
			kill,
			releaseProxy: async (id) =>
				(await import("../netproxy/lease-proxy")).releaseLeaseProxy({ store, env: host.env, kill, pidAlive }, id),
		},
		device
	);
}
