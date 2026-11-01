import type { ClockCondition } from "@delacour/warden-config/conditions.types";

/**
 * Told about every successful `Driver.clock`, so the lease carries the `clock` area and release / gc undo it
 * (COND-1). Drivers never touch the lease store: whoever opens the driver builds this (`leaseClockRecorder`).
 */
export type ClockRecorder = (condition: ClockCondition) => void;
