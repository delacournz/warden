import { isLeaseAlive, type PidAlive } from "@delacour/warden-store/liveness";
import type { Lease } from "@delacour/warden-store/types";
import type { LsJson } from "./contracts/leases.schema";

/**
 * Lease views shared by the CLI (`ls`, `devices`) and the client (`devices.list`). Light on purpose: only the store's
 * liveness check, no zod at runtime (the contract import is a type), so the CLI's cold start stays cheap.
 */

/** Every lease with its liveness: the rows of `warden ls --json`. */
export function withLeaseState(leases: readonly Lease[], now: number, pidAlive: PidAlive): LsJson["leases"] {
	return leases.map((lease) => ({ ...lease, state: isLeaseAlive(lease, now, pidAlive) ? "alive" : "stale" }));
}

/** The live device leases, keyed `<platform>:<udid>`. */
export function aliveDeviceLeases(leases: readonly Lease[], now: number, pidAlive: PidAlive): Map<string, Lease> {
	const held = new Map<string, Lease>();
	for (const lease of leases) {
		if (lease.resource.kind === "device" && isLeaseAlive(lease, now, pidAlive)) {
			held.set(`${lease.resource.platform}:${lease.resource.id}`, lease);
		}
	}
	return held;
}
