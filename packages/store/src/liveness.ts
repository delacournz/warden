import type { Lease } from "./types";

export type PidAlive = (pid: number) => boolean;

/** Heartbeats a supervised lease may miss while its pid is dead before it is stale (suspend/resume grace). */
export const LOST_HEARTBEATS = 3;

/**
 * Lease alive = pid alive || heartbeat within ttl. A supervised lease (pid + `heartbeatMs`, held by a
 * heartbeating `run` / `dev` / `batch` / `e2e`) whose pid is dead is alive only within
 * `LOST_HEARTBEATS` periods of its last heartbeat (and the ttl). Pure: pid check injected.
 */
export function isLeaseAlive(lease: Lease, now: number, pidAlive: PidAlive): boolean {
	const supervised = lease.pid !== undefined && lease.heartbeatMs !== undefined;
	const fresh = supervised ? Math.min(lease.ttlMs, LOST_HEARTBEATS * (lease.heartbeatMs ?? 0)) : lease.ttlMs;
	if (now - lease.heartbeatAt <= fresh) return true;
	return lease.pid !== undefined && pidAlive(lease.pid);
}

/** `kill(pid, 0)` probe: EPERM means the process exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}
