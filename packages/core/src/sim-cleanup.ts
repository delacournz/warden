import type { SimDetail } from "./providers/ios";
import type { DeviceRecord } from "./store";

/** Why a sim is worth deleting. Only suggestions — the user still picks and confirms. */
export type DeletionReason =
	| { kind: "unavailable" }
	| { kind: "stale"; sinceMs: number }
	| { kind: "old-runtime"; newest: string }
	| { kind: "duplicate"; of: { id: string; name: string } }
	| { kind: "idle-pool"; sinceMs: number };

export type SuggestOptions = {
	now: number;
	/** a non-warden sim not booted for this long is stale */
	staleMs: number;
	/** a warden pool sim unused for this long is idle */
	idleMs: number;
	/** warden's device records (`lastUsedAt`) */
	records: DeviceRecord[];
};

const versionOf = (runtime: string) =>
	runtime
		.replace(/^[A-Za-z]+-/, "")
		.split("-")
		.map(Number);

/** `iOS-18-6` < `iOS-26-5` < `iOS-26-10`, compared numerically. */
export function compareRuntimes(a: string, b: string): number {
	const [va, vb] = [versionOf(a), versionOf(b)];
	for (let i = 0; i < Math.max(va.length, vb.length); i++) {
		const diff = (va[i] ?? 0) - (vb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function newestRuntimeByType(sims: SimDetail[]): Map<string, string> {
	const newest = new Map<string, string>();
	for (const s of sims) {
		if (s.deviceType === undefined || s.runtime === undefined) continue;
		const current = newest.get(s.deviceType);
		if (current === undefined || compareRuntimes(s.runtime, current) > 0) newest.set(s.deviceType, s.runtime);
	}
	return newest;
}

/** Same name + runtime: the most recently booted one is kept, the rest point at it. */
function duplicateKeepers(sims: SimDetail[]): Map<string, SimDetail> {
	const groups = new Map<string, SimDetail[]>();
	for (const s of sims) {
		const key = `${s.name}\u0000${s.runtime ?? ""}`;
		groups.set(key, [...(groups.get(key) ?? []), s]);
	}
	const keeperOf = new Map<string, SimDetail>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const keeper = group.reduce((best, s) => ((s.lastBootedAt ?? -1) > (best.lastBootedAt ?? -1) ? s : best));
		for (const s of group) if (s !== keeper) keeperOf.set(s.id, keeper);
	}
	return keeperOf;
}

function reasonsFor(
	sim: SimDetail,
	opts: SuggestOptions,
	ctx: { newest: Map<string, string>; keeperOf: Map<string, SimDetail>; lastUsed: Map<string, number> }
): DeletionReason[] {
	if (!sim.available) return [{ kind: "unavailable" }];
	const reasons: DeletionReason[] = [];
	if (sim.wardenCreated) {
		const used = ctx.lastUsed.get(sim.id) ?? sim.lastBootedAt;
		if (used !== undefined && opts.now - used >= opts.idleMs)
			reasons.push({ kind: "idle-pool", sinceMs: opts.now - used });
	} else if (sim.lastBootedAt !== undefined && opts.now - sim.lastBootedAt >= opts.staleMs) {
		reasons.push({ kind: "stale", sinceMs: opts.now - sim.lastBootedAt });
	}
	const newest = sim.deviceType !== undefined ? ctx.newest.get(sim.deviceType) : undefined;
	if (newest !== undefined && sim.runtime !== undefined && compareRuntimes(sim.runtime, newest) < 0) {
		reasons.push({ kind: "old-runtime", newest });
	}
	const keeper = ctx.keeperOf.get(sim.id);
	if (keeper) reasons.push({ kind: "duplicate", of: { id: keeper.id, name: keeper.name } });
	return reasons;
}

/**
 * Which sims look safe to delete, and why: runtime removed, not booted in `staleMs`, an older
 * runtime than the newest for its device type, a same-name + runtime duplicate, or a warden pool
 * sim unused for `idleMs`. Goldens never; leases are the caller's call. Only sims with a reason are returned.
 */
export function suggestSimDeletions(sims: SimDetail[], opts: SuggestOptions): Map<string, DeletionReason[]> {
	const candidates = sims.filter((s) => !s.golden);
	const live = candidates.filter((s) => s.available);
	const ctx = {
		newest: newestRuntimeByType(live),
		keeperOf: duplicateKeepers(live),
		lastUsed: new Map(opts.records.filter((r) => r.platform === "ios").map((r) => [r.id, r.lastUsedAt])),
	};
	const out = new Map<string, DeletionReason[]>();
	for (const sim of candidates) {
		const reasons = reasonsFor(sim, opts, ctx);
		if (reasons.length > 0) out.set(sim.id, reasons);
	}
	return out;
}
