import type { Lease } from "./types";

/**
 * Shut a device down when its lease ends? Only if warden created it (`wardenDevices` holds
 * `platform:id` of the store `devices` table) or the lease's owner booted it. A device that was
 * already running when leased — e.g. the user's own Simulator.app sim — is left running.
 */
export function shouldShutdown(lease: Lease, wardenDevices: ReadonlySet<string>): boolean {
	if (lease.resource.kind !== "device") return false;
	return lease.bootedByOwner === true || wardenDevices.has(`${lease.resource.platform}:${lease.resource.id}`);
}
