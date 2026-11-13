import type { Driver, DriverResult } from "./driver.types";

/**
 * The iOS helper's check for a wedged accessibility service (`warden-simd` `AXWedgeRecovery`): when both AX readers
 * stay silent and the sim log names the wedge, it restarts backboardd (which quits the foreground app), ends its stale
 * guests and reads on. `last` is the latest check; `agoMs` counts from its end.
 */
export type AxWedgeState = {
	restarts: number;
	maxRestarts: number;
	recovering: boolean;
	/** `recover: true` only: what the check that ask ran (or joined) found; absent when none ran (budget spent) */
	checked?: "restarted" | "not-wedged" | "failed";
	last?:
		| { outcome: "restarted"; agoMs: number; ms?: number }
		| { outcome: "not-wedged"; agoMs: number }
		| { outcome: "failed"; agoMs: number; error: string };
};

/**
 * Optional capability next to the frozen `Driver` (iOS simulators): read the helper's wedge state, or with
 * `recover: true` run the check now and answer once it is over. A helper built before it answers `E_UNSUPPORTED`
 * `detail.reason: "helper_outdated"`.
 */
export type RecoversAxWedge = { axWedge(opts?: { recover?: boolean }): DriverResult<AxWedgeState> };

export function canRecoverAxWedge(driver: Driver): driver is Driver & RecoversAxWedge {
	return typeof (driver as Partial<RecoversAxWedge>).axWedge === "function";
}

/** Whether the helper restarted backboardd within the last `windowMs` (e.g. during the test that just failed). */
export function restartedWithin(state: AxWedgeState, windowMs: number): boolean {
	return state.last?.outcome === "restarted" && state.last.agoMs <= windowMs;
}
