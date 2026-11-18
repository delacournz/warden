import type { Driver, DriverResult } from "./driver.types";
import { driverErr } from "./errors";

/**
 * The Keychain ACL shim (WDN-KACL): iOS simulators ignore `SecAccessControl`, so a read of an item behind Face ID /
 * Touch ID / the passcode returns its data with no prompt. With the shim on, the injected dylib runs the item's
 * policy through LocalAuthentication first (the real system sheet, driven by `device.biometrics`) and answers the
 * OSStatus a device is expected to give. It emulates the prompt and the codes; real enforcement is a device's.
 *
 * `on` / `off` switch it (live on an app launched with it, else from the next launch: `appliesOnLaunch`); `status`
 * reads it. `generation` is the biometric enrolment generation that `biometrics("reenroll")` bumps.
 */
export type KeychainAclOp = { kind: "on" } | { kind: "off" } | { kind: "status" };

export type KeychainAclState = { enabled: boolean; generation: number; appliesOnLaunch?: true };

/** Optional capability next to the frozen `Driver`: only an iOS simulator driver with a lease offers it. */
export type ControlsKeychainAcl = { keychainAcl(op: KeychainAclOp): DriverResult<KeychainAclState> };

export function canControlKeychainAcl(driver: Driver): driver is Driver & ControlsKeychainAcl {
	return typeof (driver as Partial<ControlsKeychainAcl>).keychainAcl === "function";
}

export const KEYCHAIN_ACL_UNSUPPORTED =
	"the Keychain ACL shim is for iOS simulators; a physical device enforces ACLs itself";

/** Run `op` on `driver`, or `E_UNSUPPORTED` for a driver that has no shim (Android, a physical iPhone or iPad). */
export async function keychainAcl(driver: Driver, op: KeychainAclOp): DriverResult<KeychainAclState> {
	if (!canControlKeychainAcl(driver)) return driverErr("E_UNSUPPORTED", KEYCHAIN_ACL_UNSUPPORTED);
	return driver.keychainAcl(op);
}
