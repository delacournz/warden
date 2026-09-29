import type { Lease } from "./types";

export type PidAlive = (pid: number) => boolean;

/** Lease alive = pid alive || heartbeat within ttl. Pure: pid check injected. */
export function isLeaseAlive(lease: Lease, now: number, pidAlive: PidAlive): boolean {
	if (now - lease.heartbeatAt <= lease.ttlMs) return true;
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
