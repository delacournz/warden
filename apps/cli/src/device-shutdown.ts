import { shouldShutdown } from "@delacour/warden-core/shutdown-policy";
import type { Lease, Owner } from "@delacour/warden-core/types";
import type { CommandContext } from "./context";
import { providerFor } from "./providers";

/** `kept`: devices left running because `guard` objected (not because warden never owned them). */
export type ShutdownOutcome = { shutdown: string[]; notes: string[]; kept: string[] };

/** Async veto per lease: a reason to leave the device running, else `undefined`. */
export type ShutdownGuard = (lease: Lease) => Promise<string | undefined>;

/**
 * Shut down the devices behind `leases` that `shouldShutdown` allows: warden-created ones and ones
 * the lease owner booted. A device that was already running when leased (e.g. the user's own
 * Simulator.app sim) is left running. Call while the leases are still held, so nobody is handed a
 * device mid-shutdown. Failures become notes — releasing must still go ahead. `guard` (gc's stale
 * grace + running-app check) can veto a shutdown the policy would allow.
 */
export async function shutdownReleasedDevices(
	ctx: CommandContext,
	leases: Lease[],
	owner: Owner,
	guard?: ShutdownGuard
): Promise<ShutdownOutcome> {
	const wardenDevices = new Set(
		ctx
			.store()
			.listDevices()
			.map((d) => `${d.platform}:${d.id}`)
	);
	const outcome: ShutdownOutcome = { shutdown: [], notes: [], kept: [] };
	for (const lease of leases) {
		const r = lease.resource;
		if (r.kind !== "device") continue;
		if (!shouldShutdown(lease, wardenDevices)) {
			outcome.notes.push(`left ${r.name} (${r.id}) running: it was already running when leased`);
			continue;
		}
		const veto = await guard?.(lease);
		if (veto !== undefined) {
			outcome.kept.push(r.id);
			outcome.notes.push(`left ${r.name} (${r.id}) running: ${veto}`);
			continue;
		}
		const result = await providerFor(r.platform, ctx, owner).shutdown(r.id);
		if (result.success) outcome.shutdown.push(r.id);
		else outcome.notes.push(`shutdown ${r.id} failed: ${result.error}`);
	}
	return outcome;
}
