import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import type { Lease } from "@delacour/warden-store/types";
import type { LsJson } from "./contracts/leases.schema";

/**
 * Lease views shared by the CLI (`ls`, `devices`) and the client (`devices.list`). Light on purpose: only the store's
 * liveness check, no zod at runtime (the contract import is a type), so the CLI's cold start stays cheap.
 */

/** Lease rows with liveness. */
export class LeaseViews {
	/** Every lease with its liveness: the rows of `warden ls --json`. */
	withState(leases: readonly Lease[], now: number, pidAlive: PidAlive): LsJson["leases"] {
		return leases.map((lease) => ({
			...lease,
			state: liveness.isLeaseAlive(lease, now, pidAlive) ? "alive" : "stale",
		}));
	}

	/** The live device leases, keyed `<platform>:<udid>`. */
	aliveDevice(leases: readonly Lease[], now: number, pidAlive: PidAlive): Map<string, Lease> {
		const held = new Map<string, Lease>();
		for (const lease of leases) {
			if (lease.resource.kind === "device" && liveness.isLeaseAlive(lease, now, pidAlive)) {
				held.set(`${lease.resource.platform}:${lease.resource.id}`, lease);
			}
		}
		return held;
	}
}

export const leaseViews = new LeaseViews();
