/**
 * The one set of "can this sim go?" rules behind `warden sims audit`, `prune` and `delete`. Pure:
 * every sim gets an owner, what blocks deleting it, and why it's worth deleting; the subcommands
 * only differ in which sims they act on (`canPrune` / `canDelete` / `isSuggested`).
 *
 * - warden sims (store record or `warden-<profile>-N`): unavailable runtime, orphan (no record),
 *   idle (unused `idleMs`), budget (`maxBytes` LRU). Older runtimes / duplicates are warden's pool to manage.
 * - foreign sims: unavailable runtime, stale (not booted `staleMs`), older runtime than the newest
 *   for its device type, same name + runtime duplicate. Only the user deletes these (`sims delete`).
 * - goldens: never (that's `warden golden prune`, under the clone lock).
 */
import { formatDuration } from "../duration";
import { isGoldenName } from "../golden/golden";
import { wardenNameProfile } from "../inventory";
import { isLeaseAlive, type PidAlive } from "../liveness";
import { shortRuntime } from "../providers/ios";
import type { DeviceRecord } from "../store";
import type { Lease, Owner } from "../types";
import type { SimctlSim } from "./list";

export type SimOwner = "warden" | "golden" | "foreign";

export type SimReason =
	| { kind: "unavailable-runtime" }
	| { kind: "orphan" }
	| { kind: "idle"; sinceMs: number }
	| { kind: "stale"; sinceMs: number }
	| { kind: "old-runtime"; newest: string }
	| { kind: "duplicate"; of: { udid: string; name: string } }
	| { kind: "budget" };

/** `leased` = any lease, live or stale (a stale one is `warden gc`'s to reclaim first). */
export type SimBlocker = { kind: "leased"; owner: Owner; stale: boolean } | { kind: "booted" } | { kind: "golden" };

/** One-line summary of the rules, for the audit's VERDICT column and JSON. */
export type SimVerdict =
	| { kind: "keep"; reason: "leased" | "booted" | "golden" | "recent" }
	/** warden sim `prune` deletes */
	| { kind: "delete"; reason: SimReason["kind"] }
	/** only the user deletes it (`sims delete`, pre-ticked when hinted) */
	| { kind: "foreign"; hint?: SimReason["kind"] };

export type SimEntry = {
	udid: string;
	name: string;
	runtimeId: string;
	/** short runtime, e.g. `iOS-26-5` */
	runtime: string;
	deviceType?: string;
	state: string;
	isAvailable: boolean;
	bytes: number;
	owner: SimOwner;
	leased: boolean;
	/** latest of warden's `lastUsedAt` and simctl's `lastBootedAt` */
	lastUsedAt?: number;
	blockers: SimBlocker[];
	reasons: SimReason[];
	verdict: SimVerdict;
};

export type SimRuleOpts = {
	/** a warden sim unused this long is deletable */
	idleMs: number;
	/** a foreign sim not booted this long is suggested */
	staleMs: number;
	/** disk budget for all sims; least-recently-used warden sims are marked `budget` until under it */
	maxBytes?: number;
};

export type RulesInput = SimRuleOpts & {
	sims: readonly SimctlSim[];
	records: readonly DeviceRecord[];
	/** every lease (live or stale); only iOS device leases matter */
	leases: readonly Lease[];
	now: number;
	pidAlive: PidAlive;
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

const DAY_MS = 86_400_000;
/** `45d`, or `1h30m` under a day. */
export const formatAge = (ms: number) => (ms >= DAY_MS ? `${Math.floor(ms / DAY_MS)}d` : formatDuration(ms));

function reasonText(r: SimReason): string {
	switch (r.kind) {
		case "unavailable-runtime":
			return "runtime removed";
		case "orphan":
			return "warden-named, no warden record";
		case "idle":
			return `warden sim unused ${formatAge(r.sinceMs)}`;
		case "stale":
			return `not booted in ${formatAge(r.sinceMs)}`;
		case "old-runtime":
			return `older runtime (${r.newest} installed)`;
		case "duplicate":
			return `duplicate of ${r.of.name}`;
		case "budget":
			return "over --max-size (least recently used)";
	}
}

/** `runtime removed · not booted in 45d · …` — the delete menu hint and the audit VERDICT detail. */
export function describeReasons(reasons: readonly SimReason[]): string {
	return reasons.map(reasonText).join(" · ");
}

const leaseBlocker = (e: SimEntry) => e.blockers.some((b) => b.kind === "leased" || b.kind === "golden");

/** `warden sims prune`: a warden sim with a reason and nothing in the way. */
export const canPrune = (e: SimEntry) => e.owner === "warden" && e.blockers.length === 0 && e.reasons.length > 0;
/** `warden sims delete`: any sim the user picks, unless it's leased or a golden. */
export const canDelete = (e: SimEntry) => !leaseBlocker(e);
/** pre-ticked in `warden sims delete` (`--suggested`): deletable, a reason, not running. */
export const isSuggested = (e: SimEntry) => e.blockers.length === 0 && e.reasons.length > 0;

type Context = {
	input: RulesInput;
	newest: Map<string, string>;
	keeperOf: Map<string, SimctlSim>;
};

/** device type + runtime platform (`iOS`, `watchOS`, …): only runtimes of one platform compare. */
function typeKey(sim: SimctlSim): string | undefined {
	if (sim.deviceTypeIdentifier === undefined) return undefined;
	return `${sim.deviceTypeIdentifier}\u0000${shortRuntime(sim.runtimeId).split("-")[0]}`;
}

function newestRuntimeByType(sims: readonly SimctlSim[]): Map<string, string> {
	const newest = new Map<string, string>();
	for (const s of sims) {
		const key = typeKey(s);
		if (key === undefined) continue;
		const runtime = shortRuntime(s.runtimeId);
		const current = newest.get(key);
		if (current === undefined || compareRuntimes(runtime, current) > 0) newest.set(key, runtime);
	}
	return newest;
}

/** Same name + runtime: the most recently booted one is kept, the rest point at it. */
function duplicateKeepers(sims: readonly SimctlSim[]): Map<string, SimctlSim> {
	const groups = new Map<string, SimctlSim[]>();
	for (const s of sims) {
		const key = `${s.name}\u0000${s.runtimeId}`;
		groups.set(key, [...(groups.get(key) ?? []), s]);
	}
	const keeperOf = new Map<string, SimctlSim>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const keeper = group.reduce((best, s) => ((s.lastBootedAt ?? -1) > (best.lastBootedAt ?? -1) ? s : best));
		for (const s of group) if (s !== keeper) keeperOf.set(s.udid, keeper);
	}
	return keeperOf;
}

function ownerOf(sim: SimctlSim, record: DeviceRecord | undefined): SimOwner {
	if (isGoldenName(sim.name)) return "golden";
	return record || wardenNameProfile(sim.name) !== undefined ? "warden" : "foreign";
}

function latest(...times: Array<number | undefined>): number | undefined {
	const known = times.filter((t): t is number => t !== undefined);
	return known.length > 0 ? Math.max(...known) : undefined;
}

function blockersOf(sim: SimctlSim, owner: SimOwner, lease: Lease | undefined, input: RulesInput): SimBlocker[] {
	const blockers: SimBlocker[] = [];
	if (owner === "golden") blockers.push({ kind: "golden" });
	if (lease)
		blockers.push({ kind: "leased", owner: lease.owner, stale: !isLeaseAlive(lease, input.now, input.pidAlive) });
	if (sim.state !== "Shutdown") blockers.push({ kind: "booted" });
	return blockers;
}

function wardenReasons(record: DeviceRecord | undefined, lastUsedAt: number | undefined, ctx: Context): SimReason[] {
	if (!record) return [{ kind: "orphan" }];
	const since = lastUsedAt === undefined ? undefined : ctx.input.now - lastUsedAt;
	return since !== undefined && since >= ctx.input.idleMs ? [{ kind: "idle", sinceMs: since }] : [];
}

function foreignReasons(sim: SimctlSim, ctx: Context): SimReason[] {
	const reasons: SimReason[] = [];
	const { now, staleMs } = ctx.input;
	if (sim.lastBootedAt !== undefined && now - sim.lastBootedAt >= staleMs)
		reasons.push({ kind: "stale", sinceMs: now - sim.lastBootedAt });
	const key = typeKey(sim);
	const newest = key !== undefined ? ctx.newest.get(key) : undefined;
	if (newest !== undefined && compareRuntimes(shortRuntime(sim.runtimeId), newest) < 0)
		reasons.push({ kind: "old-runtime", newest });
	const keeper = ctx.keeperOf.get(sim.udid);
	if (keeper) reasons.push({ kind: "duplicate", of: { udid: keeper.udid, name: keeper.name } });
	return reasons;
}

function reasonsOf(
	sim: SimctlSim,
	owner: SimOwner,
	record: DeviceRecord | undefined,
	lastUsedAt: number | undefined,
	ctx: Context
): SimReason[] {
	if (owner === "golden") return [];
	if (!sim.isAvailable) return [{ kind: "unavailable-runtime" }];
	return owner === "warden" ? wardenReasons(record, lastUsedAt, ctx) : foreignReasons(sim, ctx);
}

function verdictOf(e: Omit<SimEntry, "verdict">): SimVerdict {
	const blocker = e.blockers[0];
	if (blocker) return { kind: "keep", reason: blocker.kind };
	const first = e.reasons[0];
	if (e.owner === "foreign") return first ? { kind: "foreign", hint: first.kind } : { kind: "foreign" };
	return first ? { kind: "delete", reason: first.kind } : { kind: "keep", reason: "recent" };
}

/** Least-recently-used recent warden sims get `budget` until what's left fits `maxBytes`. */
function applyBudget(entries: SimEntry[], maxBytes: number): void {
	let after = entries.filter((e) => !canPrune(e)).reduce((s, e) => s + e.bytes, 0);
	const lru = entries
		.filter((e) => e.verdict.kind === "keep" && e.verdict.reason === "recent")
		.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
	for (const e of lru) {
		if (after <= maxBytes) break;
		e.reasons.push({ kind: "budget" });
		e.verdict = { kind: "delete", reason: "budget" };
		after -= e.bytes;
	}
}

/** Every sim with its owner, blockers, reasons and verdict, in input order. */
export function judgeSims(input: RulesInput): SimEntry[] {
	const records = new Map(input.records.filter((r) => r.platform === "ios").map((r) => [r.id, r]));
	const leases = new Map(
		input.leases.flatMap((l) =>
			l.resource.kind === "device" && l.resource.platform === "ios" ? [[l.resource.id, l] as const] : []
		)
	);
	const live = input.sims.filter((s) => s.isAvailable && !isGoldenName(s.name));
	const ctx: Context = { input, newest: newestRuntimeByType(live), keeperOf: duplicateKeepers(live) };
	const entries = input.sims.map((sim): SimEntry => {
		const record = records.get(sim.udid);
		const owner = ownerOf(sim, record);
		const lease = leases.get(sim.udid);
		const lastUsedAt = latest(record?.lastUsedAt, sim.lastBootedAt);
		const base: Omit<SimEntry, "verdict"> = {
			udid: sim.udid,
			name: sim.name,
			runtimeId: sim.runtimeId,
			runtime: shortRuntime(sim.runtimeId),
			...(sim.deviceTypeIdentifier !== undefined ? { deviceType: sim.deviceTypeIdentifier } : {}),
			state: sim.state,
			isAvailable: sim.isAvailable,
			bytes: sim.dataPathSize ?? 0,
			owner,
			leased: lease !== undefined,
			...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
			blockers: blockersOf(sim, owner, lease, input),
			reasons: reasonsOf(sim, owner, record, lastUsedAt, ctx),
		};
		return { ...base, verdict: verdictOf(base) };
	});
	if (input.maxBytes !== undefined) applyBudget(entries, input.maxBytes);
	return entries;
}
