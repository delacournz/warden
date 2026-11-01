import { basename, dirname } from "node:path";
import { type BuildRecord, BuildsTable, type SimulatorRepackRecord } from "@delacour/warden-store/builds-table";
import type { PidAlive } from "@delacour/warden-store/liveness";
import type { Store } from "@delacour/warden-store/store";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { DEFAULT_MAX_CACHE_SIZE } from "./builds.defaults";
import { buildCache } from "./cache";
import { buildLock } from "./lock";

const UNITS: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** Where a cache cap came from: the command's flag, `WARDEN_MAX_CACHE_SIZE`, or `DEFAULT_MAX_CACHE_SIZE`. */
export type CacheCapSource = "flag" | "env" | "default";

export type PrunePlan = { remove: BuildRecord[]; keep: BuildRecord[]; total: number; after: number };

/** Builds used within `graceMs` of `now` stay: a cache-hit install takes no build lock (17-11). */
export type PruneGrace = { now: number; graceMs: number };

/** `warden gc`'s grace window: a build used this recently may be being installed (17-11). */
export const GC_PRUNE_GRACE_MS = 30 * 60_000;

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

/** Cache-size parsing and the LRU prune plan. Deps arrive per call, so callers share the `prune` instance. */
export class Prune {
	/** `20G`, `500M`, `1.5GB`, `1024` (bytes) → bytes (1024-based). */
	parseSize(raw: string): Result<number> {
		const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i.exec(raw.trim());
		const unit = UNITS[(match?.[2] ?? "").toUpperCase()];
		if (!match?.[1] || unit === undefined) return resultFactory.err(`invalid size "${raw}" (e.g. 20G, 500M)`);
		return resultFactory.ok(Math.floor(Number(match[1]) * unit));
	}

	formatSize(bytes: number): string {
		const [unit, scale] = (["T", "G", "M", "K"] as const)
			.map((u) => [u, UNITS[u] ?? 1] as const)
			.find(([, s]) => bytes >= s) ?? ["", 1];
		return unit === "" ? `${bytes}B` : `${(bytes / scale).toFixed(1)}${unit}`;
	}

	/**
	 * The build cache cap `warden gc`, `warden builds prune` and auto-gc share: `flag`, else
	 * `WARDEN_MAX_CACHE_SIZE`, else `DEFAULT_MAX_CACHE_SIZE` (20G). `source` says which one an invalid value
	 * came from, so a caller can treat a typo in the environment differently from one on its command line.
	 */
	cacheCap(
		flag: string | undefined,
		env: Record<string, string | undefined>
	): { source: CacheCapSource; bytes: Result<number> } {
		if (flag !== undefined) return { source: "flag", bytes: this.parseSize(flag) };
		const fromEnv = env.WARDEN_MAX_CACHE_SIZE;
		if (fromEnv !== undefined) return { source: "env", bytes: this.parseSize(fromEnv) };
		return { source: "default", bytes: this.parseSize(DEFAULT_MAX_CACHE_SIZE) };
	}

	/** Total bytes of the cached builds, summed like `plan` does (one aggregate query, no fs walk). */
	cacheTotal(store: Store): number {
		return new BuildsTable(store).totalBytes();
	}

	/**
	 * A row registered by `aliasBuild`: it points at another hash's files and owns no bytes. A legacy row's files sit in its
	 * own `<hash>` dir, so an alias is a path under another dir; a kind row's dir is named for the kind, so an alias is
	 * recognised by its size 0.
	 */
	isAlias(b: BuildRecord): boolean {
		if (this.isKinded(b)) return b.size === 0;
		return basename(dirname(b.path)) !== b.hash;
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
	plan(builds: readonly BuildRecord[], maxBytes: number, locked: ReadonlySet<string>, grace?: PruneGrace): PrunePlan {
		const total = builds.reduce((s, b) => s + b.size, 0);
		const keepNewest = this.newestRepackPerWorktree(builds);
		const kidsOf = (b: BuildRecord) =>
			b.kind === "simulator-base" ? buildCache.repacksOf(builds, b.projectKey, b.platform, b.hash) : [];
		const removable = (b: BuildRecord) => !this.isAlias(b) && !keepNewest.has(b) && !this.busy(b, locked, grace);
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
				const aliases = builds.filter((a) => a !== owner && a.path === owner.path && this.isAlias(a));
				remove.push(owner, ...aliases);
				for (const row of [owner, ...aliases]) gone.add(row);
				after -= owner.size;
			}
		}
		return { remove, keep: builds.filter((b) => !gone.has(b)), total, after };
	}

	/** Plan + (unless `dryRun`) delete cached builds down to `maxBytes`. */
	builds(input: PruneInput): PrunePlan {
		const plan = input.store.transaction(() =>
			this.plan(
				new BuildsTable(input.store).list(),
				input.maxBytes,
				buildLock.live(input.store, input.now, input.pidAlive),
				input.graceMs === undefined ? undefined : { now: input.now, graceMs: input.graceMs }
			)
		);
		if (!input.dryRun) for (const b of plan.remove) buildCache.remove(input.store, input.env, b);
		return plan;
	}

	private isKinded(b: BuildRecord): boolean {
		return b.kind !== undefined && b.kind !== "legacy";
	}

	private busy(b: BuildRecord, locked: ReadonlySet<string>, grace: PruneGrace | undefined): boolean {
		const jsKey = b.kind === "simulator-repack" || b.kind === "release" ? b.jsKey : undefined;
		if (locked.has(buildLock.key(b.projectKey, b.platform, b.hash))) return true;
		if (jsKey !== undefined && locked.has(buildLock.key(b.projectKey, b.platform, jsKey))) return true;
		return grace !== undefined && grace.now - b.lastUsedAt < grace.graceMs;
	}

	/** The newest repack (by creation) of each (project, platform, worktree): the one a checkout is running against now. */
	private newestRepackPerWorktree(builds: readonly BuildRecord[]): Set<BuildRecord> {
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
}

export const prune = new Prune();
