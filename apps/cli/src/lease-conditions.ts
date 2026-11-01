import { leaseConditions } from "@delacour/warden-core/conditions/conditions";
import { ConditionUndo } from "@delacour/warden-core/conditions/undo";
import { type Exec, processExec } from "@delacour/warden-runtime/exec";
import { liveness } from "@delacour/warden-store/liveness";
import type { Store } from "@delacour/warden-store/store";
import type { Lease } from "@delacour/warden-store/types";

/** What undoing a lease's conditions needs from a command/hook context; `exec` and `env` default to the real ones. */
export type ConditionHost = {
	store: () => Store;
	now: () => number;
	exec?: Exec;
	env?: Record<string, string | undefined>;
};

export class LeaseConditionsHelpers {
	/** True when `lease` has device conditions set (a cheap store read: no exec, nothing awaited). */
	hasConditions(host: ConditionHost, lease: Lease): boolean {
		return lease.resource.kind === "device" && leaseConditions.active(host.store(), lease.id).length > 0;
	}

	/**
	 * Undo what `lease` set on its device (network, location, clock …) and stop the processes holding it.
	 * Call while the lease is still held. Returns one note per failed reset; never throws, so a release goes ahead.
	 */
	async undoLeaseConditions(host: ConditionHost, lease: Lease): Promise<string[]> {
		if (!this.hasConditions(host, lease)) return [];
		const store = host.store();
		const env = host.env ?? process.env;
		const kill = (pid: number) => process.kill(pid, "SIGTERM");
		const done = await new ConditionUndo({
			store,
			exec: host.exec ?? processExec.run,
			env,
			now: host.now,
			pidAlive: liveness.processAlive,
			kill,
			// imported only when a network condition is set, so release/gc stay light
			releaseProxy: async (id) =>
				new (await import("@delacour/warden-core/netproxy/lease-proxy")).LeaseProxyService({
					store,
					env,
					now: host.now,
					kill,
					pidAlive: liveness.processAlive,
				}).release(id),
		}).undo(lease);
		return done.success ? [] : done.error.errors.map((e) => `conditions on ${lease.id}: ${e}`);
	}
}

export const leaseConditionsHelpers = new LeaseConditionsHelpers();
