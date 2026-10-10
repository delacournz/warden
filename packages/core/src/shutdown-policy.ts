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
