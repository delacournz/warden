import type { ConditionArea, ConditionRecord } from "@delacour/warden-config/conditions.types";
import type { Store } from "@delacour/warden-store/store";
import type { Platform } from "@delacour/warden-store/types";
import { type ConditionRow, leaseConditions } from "./conditions";
import type { UndoDeps } from "./undo";

/**
 * Conditions whose lease was deleted without `releaseDevices` undoing them first (stale reclaim in a
 * claim, eviction, rollback, an older `warden` binary): a database trigger parks them in
 * `orphan_conditions`. They are undone before the device is leased again, or by gc when it is unleased.
 */
export type Orphan = { leaseId: string; record: ConditionRecord };

type OrphanRow = ConditionRow & { lease_id: string };

export type OrphanUndoReport = { reset: ConditionArea[]; errors: string[] };

export class OrphanConditions {
	/** The orphaned conditions of one device (a cheap read: no exec). */
	read(store: Store, platform: Platform, deviceId: string): Orphan[] {
		return store.db
			.query<OrphanRow, [string, string]>(
				"SELECT area, json, owned, set_at, lease_id FROM orphan_conditions WHERE platform = ? AND device_id = ?"
			)
			.all(platform, deviceId)
			.map((row) => ({ leaseId: row.lease_id, record: leaseConditions.toRecord(row) }));
	}

	/** Every device that has orphans (gc). */
	devices(store: Store): { platform: Platform; id: string }[] {
		return store.db
			.query<{ platform: Platform; id: string }, []>(
				"SELECT DISTINCT platform, device_id AS id FROM orphan_conditions ORDER BY platform, device_id"
			)
			.all();
	}

	/**
	 * Undo `device`'s orphaned conditions with the same resets as a live lease's undo. Each orphan whose
	 * reset succeeded is deleted; a failed one stays for the next try. Idempotent and never throws. Only
	 * call it on a device about to be leased by the caller, or one nobody holds.
	 */
	async undo(deps: UndoDeps, device: { platform: Platform; id: string }): Promise<OrphanUndoReport> {
		const report: OrphanUndoReport = { reset: [], errors: [] };
		// imported here so the cheap readers above stay light for claim / gc when nothing is orphaned
		const { ConditionUndo } = await import("./undo");
		const undo = new ConditionUndo(deps);
		for (const { leaseId, record } of this.read(deps.store, device.platform, device.id)) {
			const { failures } = await undo.resetRecord(device, leaseId, record);
			if (failures.length > 0) {
				report.errors.push(...failures.map((f) => `${record.area}: ${f}`));
				continue;
			}
			this.forget(deps.store, device.platform, device.id, record.area);
			report.reset.push(record.area);
		}
		return report;
	}

	private forget(store: Store, platform: Platform, deviceId: string, area: ConditionArea): void {
		store.db
			.query("DELETE FROM orphan_conditions WHERE platform = ? AND device_id = ? AND area = ?")
			.run(platform, deviceId, area);
	}
}

export const orphanConditions = new OrphanConditions();
