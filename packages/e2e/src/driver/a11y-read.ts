import type { Driver, DriverResult, Snapshot } from "./driver.types";

/**
 * Optional capability next to the frozen `Driver` interface (pattern: `RepeatingKeys` in `typing.ts`): read the
 * screen-reader facts a plain snapshot lacks and return the snapshot with `Element.a11y` filled in. iOS: the injected
 * dylib's UIKit walk merged by identifier / frame (`ios/ios-a11y.ts`); needs the app launched with the dylib
 * (`WARDEN_A11Y=1` or the `a11y` driver option) and answers `E_UNSUPPORTED` otherwise. Android has no such driver
 * method: `warden-uiad` snapshots carry `a11y` already.
 */
export type ReadsA11y = { readA11y(snapshot: Snapshot): DriverResult<Snapshot> };

export function canReadA11y(driver: Driver): driver is Driver & ReadsA11y {
	return typeof (driver as Partial<ReadsA11y>).readA11y === "function";
}
