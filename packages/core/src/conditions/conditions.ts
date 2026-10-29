import { err, ok, type Result } from "@delacour/warden-types/result";
import type { Store } from "../store";
import {
	CONDITION_AREAS,
	type ConditionArea,
	type ConditionRecord,
	type ConditionValues,
	type OwnedProcess,
} from "./conditions.types";

type ConditionRow = { area: ConditionArea; json: string; owned: string; set_at: number };

function toRecord(row: ConditionRow): ConditionRecord {
	return {
		area: row.area,
		value: JSON.parse(row.json),
		owned: JSON.parse(row.owned) as OwnedProcess[],
		setAt: row.set_at,
	} as ConditionRecord;
}

/**
 * Persist what a lease has set on its device so release, gc and a crashed process can undo it. One
 * slot per area: recording again replaces the value. `owned` (processes undo must stop) is kept as
 * is when omitted and replaced when given — a caller swapping a proxy kills the old one itself.
 */
export function recordCondition<A extends ConditionArea>(
	store: Store,
	leaseId: string,
	area: A,
	value: ConditionValues[A],
	now: number,
	owned?: readonly OwnedProcess[]
): Result<ConditionRecord> {
	return store.transaction((): Result<ConditionRecord> => {
		if (!store.getLease(leaseId)) return err(`no lease ${leaseId}`);
		const prior = store.db
			.query<{ owned: string }, [string, string]>("SELECT owned FROM lease_conditions WHERE lease_id = ? AND area = ?")
			.get(leaseId, area);
		const handles = owned ?? (prior ? (JSON.parse(prior.owned) as OwnedProcess[]) : []);
		store.db
			.query(
				`INSERT INTO lease_conditions (lease_id, area, json, owned, set_at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT (lease_id, area) DO UPDATE SET json = excluded.json, owned = excluded.owned, set_at = excluded.set_at`
			)
			.run(leaseId, area, JSON.stringify(value), JSON.stringify(handles), now);
		return ok({ area, value, owned: handles, setAt: now } as ConditionRecord);
	});
}

/** Forget one area of a lease; false when it was not set. */
export function clearCondition(store: Store, leaseId: string, area: ConditionArea): boolean {
	return store.transaction(
		() => store.db.query("DELETE FROM lease_conditions WHERE lease_id = ? AND area = ?").run(leaseId, area).changes > 0
	);
}

/** Forget every area of a lease; returns how many were set. */
export function clearConditions(store: Store, leaseId: string): number {
	return store.transaction(
		() => store.db.query("DELETE FROM lease_conditions WHERE lease_id = ?").run(leaseId).changes
	);
}

/** What a lease currently has set, in `CONDITION_AREAS` order. */
export function activeConditions(store: Store, leaseId: string): ConditionRecord[] {
	return store.db
		.query<ConditionRow, [string]>("SELECT area, json, owned, set_at FROM lease_conditions WHERE lease_id = ?")
		.all(leaseId)
		.sort((a, b) => CONDITION_AREAS.indexOf(a.area) - CONDITION_AREAS.indexOf(b.area))
		.map(toRecord);
}
