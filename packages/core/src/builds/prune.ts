import { err, ok, type Result } from "@delacour/warden-types/result";
import type { PidAlive } from "../liveness";
import type { Store } from "../store";
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

export type PrunePlan = { remove: BuildRecord[]; keep: BuildRecord[]; total: number; after: number };

/**
 * LRU: drop least-recently-used builds until the total fits `maxBytes`. Builds whose build lock is
 * held (being fetched/installed right now) are never removed.
 */
export function planPrune(builds: readonly BuildRecord[], maxBytes: number, locked: ReadonlySet<string>): PrunePlan {
	const total = builds.reduce((s, b) => s + b.size, 0);
	const lru = [...builds].sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt);
	const remove: BuildRecord[] = [];
	let after = total;
	for (const b of lru) {
		if (after <= maxBytes) break;
		if (locked.has(buildLockKey(b.projectKey, b.platform, b.hash))) continue;
		remove.push(b);
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
};

/** Plan + (unless `dryRun`) delete cached builds down to `maxBytes`. */
export function pruneBuilds(input: PruneInput): PrunePlan {
	const plan = input.store.transaction(() =>
		planPrune(listBuilds(input.store), input.maxBytes, liveBuildLocks(input.store, input.now, input.pidAlive))
	);
	if (!input.dryRun) for (const b of plan.remove) removeBuild(input.store, input.env, b);
	return plan;
}
