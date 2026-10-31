import { clearCondition, recordCondition } from "@delacour/warden-core/conditions/conditions";
import type { ClockCondition } from "@delacour/warden-core/conditions/conditions.types";
import type { Store } from "@delacour/warden-core/store";

/**
 * Told about every successful `Driver.clock`, so the lease carries the `clock` area and release / gc undo it
 * (COND-1). Drivers never touch the lease store: whoever opens the driver builds this (`leaseClockRecorder`).
 */
export type ClockRecorder = (condition: ClockCondition) => void;

/** `ClockRecorder` for one lease: a mocked clock is recorded, `real` forgets the area. */
export function leaseClockRecorder(store: Store, leaseId: string, now: () => number = Date.now): ClockRecorder {
	return (condition) => {
		if (condition.kind === "real") clearCondition(store, leaseId, "clock");
		else recordCondition(store, leaseId, "clock", condition, now());
	};
}
