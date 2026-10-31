import { deleteSim } from "@delacour/warden-core/providers/ios";
import { deleteAfterShutdown, ephemeralEnabled, shouldShutdown } from "@delacour/warden-core/shutdown-policy";
import type { Lease, Owner } from "@delacour/warden-core/types";
import { stopHelperAfter } from "./agent-ui/stop-helper-after";
import { closeSimWindowsAfter, type ShutDownSim } from "./close-sim-windows-after";
import type { CommandContext } from "./context";
import { errorMessage } from "./hooks/json";
import { undoLeaseConditions } from "./lease-conditions";
import { providerFor } from "./providers";

/**
 * `kept`: devices left running because `guard` objected (not because warden never owned them). `deleted`: shut-down
 * ephemeral sims that were then `simctl delete`d (a subset of `shutdown`).
 */
export type ShutdownOutcome = { shutdown: string[]; notes: string[]; kept: string[]; deleted: string[] };

/** Async veto per lease: a reason to leave the device running, else `undefined`. */
export type ShutdownGuard = (lease: Lease) => Promise<string | undefined>;

/** What happened to one lease's device. */
type DeviceShutdown =
	| { kind: "skipped" }
	| { kind: "foreign"; note: string }
	| { kind: "kept"; id: string; note: string }
	| { kind: "shutdown"; id: string; sim?: ShutDownSim }
	| { kind: "failed"; note: string };

/**
 * Shut down the devices behind `leases` that `shouldShutdown` allows (never a physical device): warden-created ones and ones
 * the lease owner booted; each shut-down iOS device's `warden-simd` is stopped with it, and its viewer window closed. A device that was already running when leased (e.g. the user's own
 * Simulator.app sim) is left running. Call while the leases are still held, so nobody is handed a
 * device mid-shutdown. Failures become notes — releasing must still go ahead. `guard` (gc's stale
 * grace + running-app check) can veto a shutdown the policy would allow. Devices shut down
 * concurrently; the outcome lists them in lease order. With ephemeral sims on (`ephemeralEnabled`), each shut-down
 * warden-created, unquarantined iOS sim is then `simctl delete`d and forgotten: the caller still holds its lease, so
 * no claim can be handed it mid-delete, and the next claim clones a fresh one from the golden.
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
	const undoNotes: string[] = [];
	const one = async (lease: Lease): Promise<DeviceShutdown> => {
		const r = lease.resource;
		if (r.kind !== "device") return { kind: "skipped" };
		if (r.physical)
			return { kind: "foreign", note: `left ${r.name} (${r.id}) alone: physical device: never shut down` };
		if (!shouldShutdown(lease, wardenDevices)) {
			return { kind: "foreign", note: `left ${r.name} (${r.id}) running: it was already running when leased` };
		}
		try {
			const veto = await guard?.(lease);
			if (veto !== undefined) return { kind: "kept", id: r.id, note: `left ${r.name} (${r.id}) running: ${veto}` };
			// the device is about to stop answering: reset what the lease set on it first
			undoNotes.push(...(await undoLeaseConditions(ctx, lease)));
			const result = await providerFor(r.platform, ctx, owner).shutdown(r.id);
			if (result.success) {
				// a resident `warden-simd` is bound to the boot that just ended
				await stopHelperAfter(ctx)(r.id);
				return { kind: "shutdown", id: r.id, ...(r.platform === "ios" ? { sim: { udid: r.id, name: r.name } } : {}) };
			}
			return { kind: "failed", note: `shutdown ${r.id} failed: ${result.error}` };
		} catch (error) {
			return { kind: "failed", note: `shutdown ${r.id} failed: ${errorMessage(error)}` };
		}
	};
	const outcome: ShutdownOutcome = { shutdown: [], notes: [], kept: [], deleted: [] };
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
	const unclosed = await closeSimWindowsAfter(ctx, sims);
	if (unclosed !== undefined) outcome.notes.push(`couldn't close the simulator window (${unclosed})`);
	await deleteEphemeral(ctx, sims, outcome);
	return outcome;
}

/** `simctl delete` + forget the shut-down `sims` that are ephemeral; a failed delete is a note and keeps the record (`warden sims prune` retries). */
async function deleteEphemeral(
	ctx: CommandContext,
	sims: readonly ShutDownSim[],
	outcome: ShutdownOutcome
): Promise<void> {
	if (sims.length === 0 || !ephemeralEnabled(ctx.env)) return;
	const store = ctx.store();
	const records = new Map(store.listDevices("ios").map((d) => [d.id, d]));
	const doomed = sims.filter((s) => deleteAfterShutdown(records.get(s.udid)));
	const results = await Promise.all(
		doomed.map(async (s) => ({ sim: s, result: await deleteSim(ctx.exec, s.udid, { shutdown: false }) }))
	);
	for (const { sim, result } of results) {
		if (!result.success) {
			outcome.notes.push(`delete ${sim.udid} failed: ${result.error}`);
			continue;
		}
		store.forgetDevice("ios", sim.udid);
		outcome.deleted.push(sim.udid);
	}
}
