/**
 * Ephemeral sims (`ephemeralEnabled` in `shutdown-policy.ts`): a warden sim that is shut down and unleased is
 * garbage, since the next claim clones a fresh one from the golden. `warden gc` sweeps them here: the rules of
 * `warden sims prune` with no idle wait (`canPrune`: warden-owned, not booted, not leased, not a golden), minus
 * quarantined sims (kept for `warden sim unquarantine`), persistent sims (`warden dev`'s) and sims a claim is still cloning (their name is held by a
 * `pending:` placeholder lease, before the real lease exists). Deleted through `deleteSims`, which leases each sim
 * under the store lock first, so a claim that takes one meanwhile wins and it is skipped.
 */
import { type AsyncResult, ok } from "@delacour/warden-types/result";
import { PENDING_PREFIX } from "../claim";
import { deleteSims } from "./delete";
import { judgeMachineSims, type SimsDeps } from "./prune";
import { canPrune, type SimEntry } from "./rules";
import { DEFAULT_SIM_STALE_MS } from "./sims.defaults";

export type EphemeralSweep = {
	removed: SimEntry[];
	failed: Array<{ entry: SimEntry; error: string }>;
};

export async function sweepEphemeralSims(deps: SimsDeps): AsyncResult<EphemeralSweep> {
	const judged = await judgeMachineSims(deps, { idleMs: 0, staleMs: DEFAULT_SIM_STALE_MS });
	if (!judged.success) return judged;
	const kept = new Set(
		deps.store
			.listDevices("ios")
			.filter((d) => d.quarantinedAt !== undefined || d.persistentAt !== undefined)
			.map((d) => d.id)
	);
	const pendingNames = new Set(
		deps.store
			.listLeases()
			.flatMap((l) =>
				l.resource.kind === "device" && l.resource.id.startsWith(PENDING_PREFIX) ? [l.resource.name] : []
			)
	);
	const doomed = judged.data.filter((e) => canPrune(e) && !kept.has(e.udid) && !pendingNames.has(e.name));
	if (doomed.length === 0) return ok({ removed: [], failed: [] });
	const result = await deleteSims(deps, doomed, { label: "gc-ephemeral" });
	return ok({ removed: result.removed, failed: result.failed });
}
