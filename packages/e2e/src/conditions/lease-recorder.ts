import { activeConditions, clearCondition, recordCondition } from "@delacour/warden-core/conditions/conditions";
import type { ConditionArea, ConditionValues } from "@delacour/warden-core/conditions/conditions.types";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import type { E2eEnv } from "../env";
import { type StoreOpener, sharedStoreOpener } from "./lease-store";

/**
 * Writes what a spec changed on its device to the lease (`lease_conditions`), so `warden release` / gc can undo it
 * when the spec process dies before its own teardown. Best effort: a failure is logged and never reaches the test.
 */
export type ConditionRecorder = {
	/** the device now has `value` in `area` */
	record<A extends ConditionArea>(area: A, value: ConditionValues[A]): void;
	/**
	 * the device is back at its baseline `value`: when that is `neutral` (nothing to undo) the area is forgotten,
	 * unless a process is still held for it (a live shaping proxy), which release must still stop
	 */
	settle<A extends ConditionArea>(area: A, value: ConditionValues[A], neutral: boolean): void;
};

export type LeaseRecorderOptions = {
	leaseId: string;
	openStore?: StoreOpener;
	now?: () => number;
	log?: (line: string) => void;
	pidAlive?: PidAlive;
};

const stderrLog = (line: string): void => {
	process.stderr.write(`${line}\n`);
};

export function createLeaseRecorder(o: LeaseRecorderOptions): ConditionRecorder {
	const open = o.openStore ?? sharedStoreOpener();
	const now = o.now ?? Date.now;
	const log = o.log ?? stderrLog;
	const alive = o.pidAlive ?? processAlive;
	const failed = (area: ConditionArea, reason: string): void =>
		log(`[warden-e2e] could not record the ${area} condition on lease ${o.leaseId}: ${reason}`);
	return {
		record(area, value) {
			try {
				const store = open();
				if (!store.success) return failed(area, store.error);
				const recorded = recordCondition(store.data, o.leaseId, area, value, now());
				if (!recorded.success) failed(area, recorded.error);
			} catch (error) {
				failed(area, error instanceof Error ? error.message : String(error));
			}
		},
		settle(area, value, neutral) {
			try {
				const store = open();
				if (!store.success) return failed(area, store.error);
				const row = activeConditions(store.data, o.leaseId).find((r) => r.area === area);
				const held = row?.owned.some((p) => alive(p.pid)) ?? false;
				if (neutral && !held) {
					clearCondition(store.data, o.leaseId, area);
					return;
				}
				const recorded = recordCondition(store.data, o.leaseId, area, value, now());
				if (!recorded.success) failed(area, recorded.error);
			} catch (error) {
				failed(area, error instanceof Error ? error.message : String(error));
			}
		},
	};
}

/** The recorder for a spec under a lease; none without `WARDEN_LEASE_ID` (a bare `bun test` has no lease to record on). */
export function leaseRecorderFor(env: Pick<E2eEnv, "leaseId">): ConditionRecorder | undefined {
	return env.leaseId === undefined ? undefined : createLeaseRecorder({ leaseId: env.leaseId });
}
