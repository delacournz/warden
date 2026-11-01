import type { DeviceResource, Lease, Owner } from "@delacour/warden-store/types";
import { closeSimWindowsAfter, type ShutDownSim } from "./close-sim-windows-after";
import type { LeaseHost } from "./lease-host";
import { shouldShutdown } from "./shutdown-policy";

/** `kept`: devices left running because `guard` objected (not because warden never owned them). */
export type ShutdownOutcome = { shutdown: string[]; notes: string[]; kept: string[] };

/** Async veto per lease: a reason to leave the device running, else `undefined`. */
export type ShutdownGuard = (lease: Lease) => Promise<string | undefined>;

/** What happened to one lease's device. */
type DeviceShutdown =
	| { kind: "skipped" }
	| { kind: "foreign"; note: string }
	| { kind: "kept"; id: string; note: string }
	| { kind: "shutdown"; id: string; sim?: ShutDownSim }
	| { kind: "failed"; note: string };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The sim to close a viewer window for after an iOS shutdown. */
function simOf(r: DeviceResource): { sim?: ShutDownSim } {
	return r.platform === "ios" ? { sim: { udid: r.id, name: r.name } } : {};
}

/** Why a device warden must not shut down is left running, else undefined. */
function foreignDevice(
	lease: Lease,
	r: DeviceResource,
	wardenDevices: ReadonlySet<string>
): DeviceShutdown | undefined {
	if (r.physical) return { kind: "foreign", note: `left ${r.name} (${r.id}) alone: physical device: never shut down` };
	if (!shouldShutdown(lease, wardenDevices)) {
		return { kind: "foreign", note: `left ${r.name} (${r.id}) running: it was already running when leased` };
	}
	return undefined;
}

/**
 * Shut down the devices behind `leases` that `shouldShutdown` allows (never a physical device): warden-created ones and ones
 * the lease owner booted; each shut-down iOS device's `warden-simd` is stopped with it, and its viewer window closed. A device that was already running when leased (e.g. the user's own
 * Simulator.app sim) is left running. Call while the leases are still held, so nobody is handed a
 * device mid-shutdown. Failures become notes — releasing must still go ahead. `guard` (gc's stale
 * grace + running-app check) can veto a shutdown the policy would allow. Devices shut down
 * concurrently; the outcome lists them in lease order.
 */
export async function shutdownReleasedDevices(
	host: LeaseHost,
	leases: Lease[],
	owner: Owner,
	guard?: ShutdownGuard
): Promise<ShutdownOutcome> {
	const wardenDevices = new Set(
		host
			.store()
			.listDevices()
			.map((d) => `${d.platform}:${d.id}`)
	);
	const undoNotes: string[] = [];
	const one = async (lease: Lease): Promise<DeviceShutdown> => {
		const r = lease.resource;
		if (r.kind !== "device") return { kind: "skipped" };
		const foreign = foreignDevice(lease, r, wardenDevices);
		if (foreign) return foreign;
		try {
			const veto = await guard?.(lease);
			if (veto !== undefined) return { kind: "kept", id: r.id, note: `left ${r.name} (${r.id}) running: ${veto}` };
			// the device is about to stop answering: reset what the lease set on it first
			undoNotes.push(...((await host.conditions?.undo(lease)) ?? []));
			const result = await host.providerFor(r.platform, owner).shutdown(r.id);
			if (!result.success) return { kind: "failed", note: `shutdown ${r.id} failed: ${result.error.message}` };
			// a resident `warden-simd` is bound to the boot that just ended
			await host.stopHelper(r.id);
			return { kind: "shutdown", id: r.id, ...simOf(r) };
		} catch (error) {
			return { kind: "failed", note: `shutdown ${r.id} failed: ${errorText(error)}` };
		}
	};
	const outcome: ShutdownOutcome = { shutdown: [], notes: [], kept: [] };
	const sims: ShutDownSim[] = [];
	for (const done of await Promise.all(leases.map(one))) {
		if (done.kind === "shutdown") {
			outcome.shutdown.push(done.id);
			if (done.sim) sims.push(done.sim);
		} else if (done.kind === "kept") {
			outcome.kept.push(done.id);
			outcome.notes.push(done.note);
		} else if (done.kind !== "skipped") outcome.notes.push(done.note);
	}
	outcome.notes.push(...undoNotes);
	const unclosed = await closeSimWindowsAfter(host, sims);
	if (unclosed !== undefined) outcome.notes.push(`couldn't close the simulator window (${unclosed})`);
	return outcome;
}
