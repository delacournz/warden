import { basename, dirname } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { PidAlive } from "../liveness";
import type { Store } from "../store";
import { DEFAULT_MAX_CACHE_SIZE } from "./builds.defaults";
import { type BuildRecord, listBuilds, removeBuild } from "./cache";
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

/** A row registered by `aliasBuild`: it points into another hash's dir and owns no bytes. */
export function isAlias(b: BuildRecord): boolean {
	return basename(dirname(b.path)) !== b.hash;
}

/**
 * LRU: drop least-recently-used builds until the total fits `maxBytes`. Builds whose build lock is
 * held (being fetched / built right now) and, with `grace`, builds used within its window (a cache
 * hit being installed) are never removed. Alias rows are not candidates; they go with their primary.
 */
export function planPrune(
	builds: readonly BuildRecord[],
	maxBytes: number,
	locked: ReadonlySet<string>,
	grace?: PruneGrace
): PrunePlan {
	const total = builds.reduce((s, b) => s + b.size, 0);
	const lru = [...builds].sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt);
	const remove: BuildRecord[] = [];
	let after = total;
	for (const b of lru) {
		if (after <= maxBytes) break;
		if (isAlias(b) || locked.has(buildLockKey(b.projectKey, b.platform, b.hash))) continue;
		if (grace && grace.now - b.lastUsedAt < grace.graceMs) continue;
		remove.push(b, ...builds.filter((a) => a !== b && a.path === b.path && isAlias(a)));
		after -= b.size;
	}
	return { remove, keep: builds.filter((b) => !remove.includes(b)), total, after };
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
