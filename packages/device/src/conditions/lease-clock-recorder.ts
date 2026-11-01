import { leaseConditions } from "@delacour/warden-core/conditions/conditions";
import type { ClockRecorder } from "@delacour/warden-driver/clock-recorder";
import type { Store } from "@delacour/warden-store/store";

/** `ClockRecorder` for one lease: a mocked clock is recorded, `real` forgets the area. */
export function leaseClockRecorder(store: Store, leaseId: string, now: () => number = Date.now): ClockRecorder {
	return (condition) => {
		if (condition.kind === "real") leaseConditions.clear(store, leaseId, "clock");
		else leaseConditions.record(store, leaseId, "clock", condition, now());
	};
}
