import { leaseConditions } from "@delacour/warden-core/conditions/conditions";
import type { ClockRecorder } from "@delacour/warden-driver/clock-recorder";
import type { Store } from "@delacour/warden-store/store";

/** `ClockRecorder` for one lease: a mocked clock is recorded, `real` forgets the area. */
export class LeaseClockRecorder {
	constructor(
		private readonly store: Store,
		private readonly leaseId: string,
		private readonly now: () => number = Date.now
	) {}

	readonly record: ClockRecorder = (condition) => {
		if (condition.kind === "real") leaseConditions.clear(this.store, this.leaseId, "clock");
		else leaseConditions.record(this.store, this.leaseId, "clock", condition, this.now());
	};
}
