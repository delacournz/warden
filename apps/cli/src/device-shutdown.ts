import { shouldShutdown } from "@delacour/warden-core/shutdown-policy";
import type { Lease, Owner } from "@delacour/warden-core/types";
import type { CommandContext } from "./context";
import { errorMessage } from "./hooks/json";
import { providerFor } from "./providers";

/** `kept`: devices left running because `guard` objected (not because warden never owned them). */
export type ShutdownOutcome = { shutdown: string[]; notes: string[]; kept: string[] };

/** Async veto per lease: a reason to leave the device running, else `undefined`. */
export type ShutdownGuard = (lease: Lease) => Promise<string | undefined>;

/** What happened to one lease's device. */
type DeviceShutdown =
	| { kind: "skipped" }
	| { kind: "foreign"; note: string }
	| { kind: "kept"; id: string; note: string }
	| { kind: "shutdown"; id: string }
	| { kind: "failed"; note: string };

/**
 * Shut down the devices behind `leases` that `shouldShutdown` allows: warden-created ones and ones
 * the lease owner booted. A device that was already running when leased (e.g. the user's own
 * Simulator.app sim) is left running. Call while the leases are still held, so nobody is handed a
 * device mid-shutdown. Failures become notes — releasing must still go ahead. `guard` (gc's stale
 * grace + running-app check) can veto a shutdown the policy would allow. Devices shut down
 * concurrently; the outcome lists them in lease order.
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
	const one = async (lease: Lease): Promise<DeviceShutdown> => {
		const r = lease.resource;
		if (r.kind !== "device") return { kind: "skipped" };
		if (!shouldShutdown(lease, wardenDevices)) {
			return { kind: "foreign", note: `left ${r.name} (${r.id}) running: it was already running when leased` };
		}
		try {
			const veto = await guard?.(lease);
			if (veto !== undefined) return { kind: "kept", id: r.id, note: `left ${r.name} (${r.id}) running: ${veto}` };
			const result = await providerFor(r.platform, ctx, owner).shutdown(r.id);
			if (result.success) return { kind: "shutdown", id: r.id };
			return { kind: "failed", note: `shutdown ${r.id} failed: ${result.error}` };
		} catch (error) {
			return { kind: "failed", note: `shutdown ${r.id} failed: ${errorMessage(error)}` };
		}
	};
	const outcome: ShutdownOutcome = { shutdown: [], notes: [], kept: [] };
	for (const done of await Promise.all(leases.map(one))) {
		if (done.kind === "shutdown") outcome.shutdown.push(done.id);
		else if (done.kind === "kept") {
			outcome.kept.push(done.id);
			outcome.notes.push(done.note);
		} else if (done.kind !== "skipped") outcome.notes.push(done.note);
	}
	return outcome;
}
