import type { AlertInfo, Driver, DriverResult } from "./driver.types";

/**
 * Optional capabilities a driver can offer next to the frozen `Driver` interface, for `device.alert` and
 * `device.openLink` (pattern: `RepeatingKeys` in `typing.ts`). A driver without them is still fully usable: the
 * device layer falls back to `Driver.alert()` and to waiting out `openLink`'s window.
 */

/**
 * The iOS accessibility readers a system alert can be read through. `ax` is the host reader: it sees
 * SpringBoard-hosted sheets ("Open in …?", permission prompts) and never touches the in-simulator bridge, so a
 * stuck stream or a relaunched app cannot slow it. `axbridge` is the in-simulator bridge: it also sees prompts the
 * app owns (the Keychain "Save Password?" sheet, app alerts), which `ax` reports as one empty root.
 */
export type AlertBackend = "ax" | "axbridge";

/**
 * `alert()` through ONE reader, so a screen without an alert costs one tree read where `Driver.alert()` reads both.
 * `null` = this reader shows none.
 */
export type ReadsAlertOn = { alertOn(backend: AlertBackend): DriverResult<AlertInfo | null> };

export function canReadAlertOn(driver: Driver): driver is Driver & ReadsAlertOn {
	return typeof (driver as Partial<ReadsAlertOn>).alertOn === "function";
}

/**
 * Whether the app with `bundleId` owns the foreground right now: a read of the helper's own state, no tree read and no
 * waiting. `false` while SpringBoard (a system sheet), Safari or another app is in front.
 */
export type ProbesFrontmost = { isFrontmost(bundleId: string): DriverResult<boolean> };

export function canProbeFrontmost(driver: Driver): driver is Driver & ProbesFrontmost {
	return typeof (driver as Partial<ProbesFrontmost>).isFrontmost === "function";
}
