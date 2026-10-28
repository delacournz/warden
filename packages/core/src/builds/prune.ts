import { basename, dirname } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { PidAlive } from "../liveness";
import type { Store } from "../store";
import { DEFAULT_MAX_CACHE_SIZE } from "./builds.defaults";
import { type BuildRecord, listBuilds, removeBuild, repacksOf, type SimulatorRepackRecord } from "./cache";
import { buildLockKey, liveBuildLocks } from "./lock";

const UNITS: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `20G`, `500M`, `1.5GB`, `1024` (bytes) → bytes (1024-based). */
export function parseSize(raw: string): Result<number> {
	const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i.exec(raw.trim());
	const unit = UNITS[(match?.[2] ?? "").toUpperCase()];
	if (!match?.[1] || unit === undefined) return err(`invalid size "${raw}" (e.g. 20G, 500M)`);
	return ok(Math.floor(Number(match[1]) * unit));
}

export function formatSize(bytes: number): string {
	const [unit, scale] = (["T", "G", "M", "K"] as const)
		.map((u) => [u, UNITS[u] ?? 1] as const)
		.find(([, s]) => bytes >= s) ?? ["", 1];
	return unit === "" ? `${bytes}B` : `${(bytes / scale).toFixed(1)}${unit}`;
}

/** Where a cache cap came from: the command's flag, `WARDEN_MAX_CACHE_SIZE`, or `DEFAULT_MAX_CACHE_SIZE`. */
export type CacheCapSource = "flag" | "env" | "default";

/**
 * The build cache cap `warden gc`, `warden builds prune` and auto-gc share: `flag`, else
 * `WARDEN_MAX_CACHE_SIZE`, else `DEFAULT_MAX_CACHE_SIZE` (20G). `source` says which one an invalid value
 * came from, so a caller can treat a typo in the environment differently from one on its command line.
 */
export function cacheCap(
	flag: string | undefined,
	env: Record<string, string | undefined>
): { source: CacheCapSource; bytes: Result<number> } {
	if (flag !== undefined) return { source: "flag", bytes: parseSize(flag) };
	const fromEnv = env.WARDEN_MAX_CACHE_SIZE;
	if (fromEnv !== undefined) return { source: "env", bytes: parseSize(fromEnv) };
	return { source: "default", bytes: parseSize(DEFAULT_MAX_CACHE_SIZE) };
}

/** Total bytes of the cached builds, summed like `planPrune` does (one aggregate query, no fs walk). */
export function cacheTotal(store: Store): number {
	return store.db.query<{ total: number }, []>("SELECT COALESCE(SUM(size), 0) AS total FROM builds").get()?.total ?? 0;
}

export type PrunePlan = { remove: BuildRecord[]; keep: BuildRecord[]; total: number; after: number };

/** Builds used within `graceMs` of `now` stay: a cache-hit install takes no build lock (17-11). */
export type PruneGrace = { now: number; graceMs: number };

/** `warden gc`'s grace window: a build used this recently may be being installed (17-11). */
export const GC_PRUNE_GRACE_MS = 30 * 60_000;

const isKinded = (b: BuildRecord) => b.kind !== undefined && b.kind !== "legacy";

/**
 * A row registered by `aliasBuild`: it points at another hash's files and owns no bytes. A legacy row's files sit in its
 * own `<hash>` dir, so an alias is a path under another dir; a kind row's dir is named for the kind, so an alias is
 * recognised by its size 0.
 */
export function isAlias(b: BuildRecord): boolean {
	if (isKinded(b)) return b.size === 0;
	return basename(dirname(b.path)) !== b.hash;
}

/** The newest repack (by creation) of each (project, platform, worktree): the one a checkout is running against now. */
function newestRepackPerWorktree(builds: readonly BuildRecord[]): Set<BuildRecord> {
	const newest = new Map<string, SimulatorRepackRecord>();
	for (const b of builds) {
		if (b.kind !== "simulator-repack" || b.worktree === undefined) continue;
		const id = `${b.projectKey}|${b.platform}|${b.worktree}`;
		const best = newest.get(id);
		if (!best || b.createdAt > best.createdAt || (b.createdAt === best.createdAt && b.lastUsedAt > best.lastUsedAt)) {
			newest.set(id, b);
		}
	}
	return new Set(newest.values());
}

/**
 * LRU: drop least-recently-used builds until the total fits `maxBytes`. Builds whose build lock is
 * held (being fetched / built right now) and, with `grace`, builds used within its window (a cache
 * hit being installed) are never removed. Alias rows are not candidates; they go with their primary.
 *
 * Kinds: a repack is seconds to rebuild, a base minutes, so repacks go first (LRU among them, which is LRU per base),
 * then everything else. The newest repack of each worktree always stays, and so does its base. A `simulator-base` is
 * only removed with all its repacks (a repack of a removed base is dead), so it needs every one of them to be removable.
 */
export function planPrune(
	builds: readonly BuildRecord[],
	maxBytes: number,
	locked: ReadonlySet<string>,
	grace?: PruneGrace
): PrunePlan {
	const total = builds.reduce((s, b) => s + b.size, 0);
	const keepNewest = newestRepackPerWorktree(builds);
	const kidsOf = (b: BuildRecord) =>
		b.kind === "simulator-base" ? repacksOf(builds, b.projectKey, b.platform, b.hash) : [];
	const busy = (b: BuildRecord) => {
		const jsKey = b.kind === "simulator-repack" || b.kind === "release" ? b.jsKey : undefined;
		if (locked.has(buildLockKey(b.projectKey, b.platform, b.hash))) return true;
		if (jsKey !== undefined && locked.has(buildLockKey(b.projectKey, b.platform, jsKey))) return true;
		return grace !== undefined && grace.now - b.lastUsedAt < grace.graceMs;
	};
	const removable = (b: BuildRecord) => !isAlias(b) && !keepNewest.has(b) && !busy(b);
	const lru = [...builds].sort(
		(a, b) =>
			Number(b.kind === "simulator-repack") - Number(a.kind === "simulator-repack") ||
			a.lastUsedAt - b.lastUsedAt ||
			a.createdAt - b.createdAt
	);
	const gone = new Set<BuildRecord>();
	const remove: BuildRecord[] = [];
	let after = total;
	for (const b of lru) {
		if (after <= maxBytes) break;
		if (gone.has(b) || !removable(b)) continue;
		const kids = kidsOf(b).filter((k) => !gone.has(k));
		if (kids.some((k) => !removable(k))) continue;
		for (const owner of [b, ...kids]) {
			const aliases = builds.filter((a) => a !== owner && a.path === owner.path && isAlias(a));
			remove.push(owner, ...aliases);
			for (const row of [owner, ...aliases]) gone.add(row);
			after -= owner.size;
		}
	}
	return { remove, keep: builds.filter((b) => !gone.has(b)), total, after };
}

export type PruneInput = {
	store: Store;
	env: Record<string, string | undefined>;
	maxBytes: number;
	now: number;
	pidAlive: PidAlive;
	dryRun?: boolean;
	/** keep builds used within this long of `now` (`warden gc`: an install may be in flight) */
	graceMs?: number;
};

/** Plan + (unless `dryRun`) delete cached builds down to `maxBytes`. */
export function pruneBuilds(input: PruneInput): PrunePlan {
	const plan = input.store.transaction(() =>
		planPrune(
			listBuilds(input.store),
			input.maxBytes,
			liveBuildLocks(input.store, input.now, input.pidAlive),
			input.graceMs === undefined ? undefined : { now: input.now, graceMs: input.graceMs }
		)
	);
	if (!input.dryRun) for (const b of plan.remove) removeBuild(input.store, input.env, b);
	return plan;
}
