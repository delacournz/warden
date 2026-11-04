import {
	addCost,
	type Budget,
	type CapacityConfig,
	type Cost,
	deviceCost,
	fits,
	hostUsage,
	maxConcurrent,
} from "./capacity";
import type { MemoryPressure } from "./host";
import type { LeaseEvent } from "./lease-events";
import { peakOverlap } from "./lease-stats";
import type { Store } from "./store";
import type { InventoryDevice, Platform } from "./types";

/**
 * The learned warm pool (opt-in, `WARDEN_WARM=1`): keep as many slim, idle, warden-created devices booted
 * per (platform, profile) as the last 24 h needed at once, so a claim finds a ready device. Pure planning
 * lives here; `warden gc` boots, `claim` (eviction order) and the idle reaper read the persisted set.
 */

export const WARM_WINDOW_MS = 24 * 60 * 60_000;
/** store meta key holding the warm set gc computed last */
export const WARM_META_KEY = "warm_set";
/** a persisted warm set older than this is ignored (gc stopped running, or WARDEN_WARM was turned off) */
export const WARM_SET_TTL_MS = 30 * 60_000;
/** label + TTL of the lease gc holds on a device while it warm-boots it */
export const WARM_BOOT_LABEL = "warm-boot";
export const WARM_BOOT_TTL_MS = 5 * 60_000;

export function warmEnabled(env: Record<string, string | undefined>): boolean {
	const value = env.WARDEN_WARM?.trim().toLowerCase();
	return value === "1" || value === "on" || value === "true" || value === "yes";
}

export type WarmKey = { platform: Platform; profile: string };

export type WarmDemand = WarmKey & { peak: number };

const keyOf = (k: WarmKey): string => `${k.platform}\u0000${k.profile}`;

/**
 * Peak concurrent device leases per (platform, profile) from `granted` → `released` | `expired` intervals.
 * A lease still held at `now` runs until `now`; a lease whose grant is before the event list is not seen.
 */
export function warmDemand(events: readonly LeaseEvent[], now: number): WarmDemand[] {
	const grants = new Map<string, { at: number; key: WarmKey }>();
	const ends = new Map<string, number>();
	for (const e of events) {
		if (e.leaseId === undefined) continue;
		if (e.type === "granted" && e.data.profile !== undefined) {
			grants.set(e.leaseId, { at: e.at, key: { platform: e.data.platform, profile: e.data.profile } });
		} else if (e.type === "released" || e.type === "expired") ends.set(e.leaseId, e.at);
	}
	const byKey = new Map<string, { key: WarmKey; intervals: { start: number; end: number }[] }>();
	for (const [leaseId, grant] of grants) {
		const k = keyOf(grant.key);
		const entry = byKey.get(k) ?? { key: grant.key, intervals: [] };
		entry.intervals.push({ start: grant.at, end: ends.get(leaseId) ?? now });
		byKey.set(k, entry);
	}
	return [...byKey.values()].map(({ key, intervals }) => ({ ...key, peak: peakOverlap(intervals) }));
}

export type WarmRow = WarmKey & {
	/** devices wanted booted: the 24 h peak (at least 1 for the queue head's profile), capped by the budget */
	target: number;
	/** warden devices of this profile booted now */
	actual: number;
	/** shut-down pool devices to boot now (empty at memory pressure, and never past the budget) */
	boot: InventoryDevice[];
	/** the 24 h peak before capping */
	peak: number;
};

export type WarmPlan = {
	rows: WarmRow[];
	/** `platform:id` of the booted devices that make up the target: the reaper and eviction spare them */
	warm: string[];
};

export type WarmInput = {
	demand: readonly WarmDemand[];
	/** the profile the admission queue's head waits for */
	queueHead?: WarmKey;
	pressure: MemoryPressure;
	/** host inventory with warden marks (`markWardenDevices`) */
	devices: readonly InventoryDevice[];
	/** ids of iOS sims whose store record says `sim slim` ran */
	slimmed: ReadonlySet<string>;
	/** `platform:id` of devices holding a live lease */
	leased: ReadonlySet<string>;
	budget: Budget;
	config: CapacityConfig;
};

const idOf = (d: InventoryDevice): string => `${d.platform}:${d.id}`;

const poolDevice = (d: InventoryDevice): boolean =>
	d.wardenCreated && d.golden !== true && d.quarantined !== true && d.physical === undefined;

const isUp = (d: InventoryDevice): boolean => d.state === "booted" || d.state === "booting";

/** Keys with demand (plus the queue head's), head first, then by peak. */
function orderedKeys(demand: ReadonlyMap<string, number>, head: WarmKey | undefined): WarmKey[] {
	const isHead = (k: WarmKey) => (head !== undefined && keyOf(head) === keyOf(k) ? 1 : 0);
	return [...demand.keys()]
		.map((k): WarmKey => {
			const [platform = "ios", profile = ""] = k.split("\u0000");
			return { platform: platform as Platform, profile };
		})
		.sort(
			(a, b) =>
				isHead(b) - isHead(a) ||
				(demand.get(keyOf(b)) ?? 0) - (demand.get(keyOf(a)) ?? 0) ||
				a.platform.localeCompare(b.platform) ||
				a.profile.localeCompare(b.profile)
		);
}

/** Shut-down pool devices that may be warm-booted: unleased, and slim when iOS. */
function bootable(d: InventoryDevice, input: WarmInput): boolean {
	return d.state === "shutdown" && !input.leased.has(idOf(d)) && (d.platform !== "ios" || input.slimmed.has(d.id));
}

/** Boot candidates, in order, while the target is unmet and the host usage plus each boot fits the budget. */
function pickBoots(
	pool: readonly InventoryDevice[],
	up: number,
	target: number,
	usage: Cost,
	input: WarmInput
): { boot: InventoryDevice[]; usage: Cost } {
	const boot: InventoryDevice[] = [];
	const candidates = input.pressure === "normal" ? pool.filter((d) => bootable(d, input)) : [];
	let used = usage;
	for (const d of candidates) {
		if (up + boot.length >= target) break;
		const cost = deviceCost(d.platform, input.config, { slim: d.platform === "ios" });
		if (!fits(used, cost, input.budget).fits) break;
		used = addCost(used, cost);
		boot.push(d);
	}
	return { boot, usage: used };
}

/**
 * Per (platform, profile): target (24 h peak, queue head's profile first and at least 1, capped by
 * `maxConcurrent`), actual, and which shut-down pool devices to boot. Boots only existing pool devices
 * (never creates; iOS sims must be slim) that are unleased and unquarantined, only at `normal` pressure,
 * and only while the whole host usage plus the boot still fits the budget.
 */
export function computeWarmPlan(input: WarmInput): WarmPlan {
	const { devices, budget, config } = input;
	const demand = new Map(input.demand.map((d) => [keyOf(d), d.peak]));
	const head = input.queueHead;
	if (head !== undefined && !demand.has(keyOf(head))) demand.set(keyOf(head), 0);
	let usage = hostUsage(devices, config, input.slimmed);
	const rows: WarmRow[] = [];
	const warm: string[] = [];
	for (const key of orderedKeys(demand, head)) {
		const peak = demand.get(keyOf(key)) ?? 0;
		const wantHead = head !== undefined && keyOf(head) === keyOf(key);
		const target = Math.min(wantHead ? Math.max(peak, 1) : peak, maxConcurrent(key.platform, budget, config));
		const pool = devices.filter((d) => poolDevice(d) && d.platform === key.platform && d.profile === key.profile);
		const up = pool.filter(isUp);
		warm.push(...up.slice(0, target).map(idOf));
		const picked = pickBoots(pool, up.length, target, usage, input);
		const boot = picked.boot;
		usage = picked.usage;
		warm.push(...boot.map(idOf));
		rows.push({ ...key, target, actual: up.length, boot, peak });
	}
	return { rows, warm };
}

type Persisted = { at: number; warm: readonly string[] };

/** Persist the warm set for the claim path and the idle reaper (an empty set when the pool is off). */
export function saveWarmSet(store: Pick<Store, "setMeta">, warm: readonly string[], now: number): void {
	store.setMeta(WARM_META_KEY, JSON.stringify({ at: now, warm } satisfies Persisted));
}

/** `platform:id` of the devices gc last decided make up the warm pool; empty when unset, malformed or stale. */
export function readWarmSet(store: Pick<Store, "getMeta">, now: number): ReadonlySet<string> {
	const raw = store.getMeta(WARM_META_KEY);
	if (raw === undefined) return new Set();
	try {
		const parsed = JSON.parse(raw) as Partial<Persisted>;
		if (typeof parsed.at !== "number" || !Array.isArray(parsed.warm) || now - parsed.at > WARM_SET_TTL_MS)
			return new Set();
		return new Set(parsed.warm.filter((w): w is string => typeof w === "string"));
	} catch {
		return new Set();
	}
}
