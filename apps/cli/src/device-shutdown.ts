import { shouldShutdown } from "@warden/core/shutdown-policy";
import type { Lease, Owner } from "@warden/core/types";
import type { CommandContext } from "./context";
import { providerFor } from "./providers";

export type ShutdownOutcome = { shutdown: string[]; notes: string[] };

/**
 * Shut down the devices behind `leases` that `shouldShutdown` allows: warden-created ones and ones
 * the lease owner booted. A device that was already running when leased (e.g. the user's own
 * Simulator.app sim) is left running. Call while the leases are still held, so nobody is handed a
 * device mid-shutdown. Failures become notes — releasing must still go ahead.
 */
export async function shutdownReleasedDevices(
	ctx: CommandContext,
	leases: Lease[],
	owner: Owner
): Promise<ShutdownOutcome> {
	const wardenDevices = new Set(
		ctx
			.store()
			.listDevices()
			.map((d) => `${d.platform}:${d.id}`)
	);
	const outcome: ShutdownOutcome = { shutdown: [], notes: [] };
	for (const lease of leases) {
		const r = lease.resource;
		if (r.kind !== "device") continue;
		if (!shouldShutdown(lease, wardenDevices)) {
			outcome.notes.push(`left ${r.name} (${r.id}) running: it was already running when leased`);
			continue;
		}
		const result = await providerFor(r.platform, ctx, owner).shutdown(r.id);
		if (result.success) outcome.shutdown.push(r.id);
		else outcome.notes.push(`shutdown ${r.id} failed: ${result.error}`);
	}
	return outcome;
}
