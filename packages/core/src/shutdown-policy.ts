import { isGoldenName } from "./golden/golden";
import type { DeviceRecord } from "./store";
import type { Lease } from "./types";

/**
 * Shut a device down when its lease ends? Only if warden created it (`wardenDevices` holds
 * `platform:id` of the store `devices` table) or the lease's owner booted it. A physical device
 * (`resource.physical`) is never shut down. A device that was already running when leased — e.g. the
 * user's own Simulator.app sim — is left running.
 */
export function shouldShutdown(lease: Lease, wardenDevices: ReadonlySet<string>): boolean {
	if (lease.resource.kind !== "device" || lease.resource.physical) return false;
	return lease.bootedByOwner === true || wardenDevices.has(`${lease.resource.platform}:${lease.resource.id}`);
}

/** A lease that went stale less than this ago may still be in use (agent between tool calls). */
export const STALE_SHUTDOWN_GRACE_MS = 10 * 60_000;

/** How long ago the lease went stale: its ttl ran out at `heartbeatAt + ttlMs` (never negative). */
export function staleForMs(lease: Lease, now: number): number {
	return Math.max(0, now - (lease.heartbeatAt + lease.ttlMs));
}

/**
 * Why a stale lease's device must NOT be shut down yet, else `undefined`: the lease went stale
 * inside the grace window, or an app is in the foreground on it (`appRunning`, probed by the CLI
 * layer). Applies on top of `shouldShutdown`.
 */
export function staleShutdownBlock(lease: Lease, now: number, appRunning: boolean): string | undefined {
	const ago = staleForMs(lease, now);
	if (ago < STALE_SHUTDOWN_GRACE_MS) {
		return `lease went stale ${Math.round(ago / 60_000)}m ago (< ${STALE_SHUTDOWN_GRACE_MS / 60_000}m grace)`;
	}
	if (appRunning) return "an app is running on it";
	return undefined;
}

const OFF = new Set(["0", "false", "off", "no"]);

/**
 * Ephemeral iOS sims: a warden sim is `simctl delete`d once it is shut down, and the next claim clones a
 * fresh one from the golden. On unless `WARDEN_EPHEMERAL` is 0/false/off/no, and off with goldens off
 * (`WARDEN_GOLDEN=0`), where a fresh sim would be a slow `simctl create` + first boot.
 */
export function ephemeralEnabled(env: Record<string, string | undefined>): boolean {
	if (env.WARDEN_GOLDEN === "0") return false;
	return !OFF.has(env.WARDEN_EPHEMERAL?.trim().toLowerCase() ?? "");
}

/**
 * Delete this device once it is shut down (with `ephemeralEnabled`)? Only a warden-created iOS sim (it has a
 * store `record`) that is not quarantined (kept for `warden sim unquarantine`), not persistent (`warden dev`'s,
 * `devKeepsSim`) and not a golden. A sim warden
 * didn't create — even one the lease owner booted — is never deleted.
 */
export function deleteAfterShutdown(record: DeviceRecord | undefined): boolean {
	return (
		record !== undefined &&
		record.platform === "ios" &&
		record.quarantinedAt === undefined &&
		record.persistentAt === undefined &&
		!isGoldenName(record.name)
	);
}

const ON = new Set(["1", "true", "on", "yes"]);

/** Does `warden dev` keep its sim (mark it persistent) so installs and logins survive? Yes unless `WARDEN_EPHEMERAL_DEV` is on. */
export function devKeepsSim(env: Record<string, string | undefined>): boolean {
	return !ON.has(env.WARDEN_EPHEMERAL_DEV?.trim().toLowerCase() ?? "");
}
