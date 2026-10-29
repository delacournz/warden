import { activeConditions } from "@delacour/warden-core/conditions/conditions";
import { undoConditions } from "@delacour/warden-core/conditions/undo";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { processAlive } from "@delacour/warden-core/liveness";
import type { Store } from "@delacour/warden-core/store";
import type { Lease } from "@delacour/warden-core/types";

/** What undoing a lease's conditions needs from a command/hook context; `exec` and `env` default to the real ones. */
export type ConditionHost = {
	store: () => Store;
	now: () => number;
	exec?: Exec;
	env?: Record<string, string | undefined>;
};

/** True when `lease` has device conditions set (a cheap store read: no exec, nothing awaited). */
export function hasConditions(host: ConditionHost, lease: Lease): boolean {
	return lease.resource.kind === "device" && activeConditions(host.store(), lease.id).length > 0;
}

/**
 * Undo what `lease` set on its device (network, location, clock …) and stop the processes holding it.
 * Call while the lease is still held. Returns one note per failed reset; never throws, so a release goes ahead.
 */
export async function undoLeaseConditions(host: ConditionHost, lease: Lease): Promise<string[]> {
	if (!hasConditions(host, lease)) return [];
	const done = await undoConditions(
		{
			store: host.store(),
			exec: host.exec ?? bunExec,
			env: host.env ?? process.env,
			now: host.now,
			pidAlive: processAlive,
			kill: (pid) => process.kill(pid, "SIGTERM"),
		},
		lease
	);
	return done.success ? [] : done.error.errors.map((e) => `conditions on ${lease.id}: ${e}`);
}
