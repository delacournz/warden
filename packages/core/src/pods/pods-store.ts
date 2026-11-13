import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { liveBuildLocks } from "../builds/lock";
import type { PidAlive } from "../liveness";
import { type Store, wardenHome } from "../store";
import type { Env, PodsEntry, PodsMode } from "./pods.types";

const LOCK_PREFIX = "pods|";

/** `$WARDEN_HOME/pods` */
export function podsRoot(env: Env): string {
	return join(wardenHome(env), "pods");
}

export function podsEntryDir(env: Env, key: string): string {
	return join(podsRoot(env), key);
}

/** The build-lock key serialising work on one pods key. */
export function podsLockKey(key: string): string {
	return `${LOCK_PREFIX}${key}`;
}

type Row = {
	key: string;
	mode: string;
	root: string;
	project_rel: string;
	size_bytes: number;
	created_at: number;
	last_used_at: number;
	pod_version: string;
	xcode_version: string;
};

function fromRow(row: Row): PodsEntry {
	return {
		key: row.key,
		mode: row.mode as PodsMode,
		root: row.root,
		projectRel: row.project_rel,
		sizeBytes: row.size_bytes,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		podVersion: row.pod_version,
		xcodeVersion: row.xcode_version,
	};
}

export function getPodsEntry(store: Store, key: string): PodsEntry | undefined {
	const row = store.db.query<Row, [string]>("SELECT * FROM pods_cache WHERE key = ?").get(key);
	return row ? fromRow(row) : undefined;
}

/** Every entry, most recently used first. */
export function listPodsEntries(store: Store): PodsEntry[] {
	return store.db.query<Row, []>("SELECT * FROM pods_cache ORDER BY last_used_at DESC, key").all().map(fromRow);
}

export function insertPodsEntry(store: Store, entry: PodsEntry): void {
	store.db
		.query(
			`INSERT INTO pods_cache (key, mode, root, project_rel, size_bytes, created_at, last_used_at, pod_version, xcode_version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (key) DO UPDATE SET mode = excluded.mode, root = excluded.root, project_rel = excluded.project_rel,
			   size_bytes = excluded.size_bytes, last_used_at = excluded.last_used_at, pod_version = excluded.pod_version,
			   xcode_version = excluded.xcode_version`
		)
		.run(
			entry.key,
			entry.mode,
			entry.root,
			entry.projectRel,
			entry.sizeBytes,
			entry.createdAt,
			entry.lastUsedAt,
			entry.podVersion,
			entry.xcodeVersion
		);
}

export function touchPodsEntry(store: Store, key: string, now: number): void {
	store.db.query("UPDATE pods_cache SET last_used_at = ? WHERE key = ?").run(now, key);
}

function deleteEntry(store: Store, env: Env, entry: PodsEntry): void {
	store.transaction(() => {
		store.db.query("DELETE FROM pods_cache WHERE key = ?").run(entry.key);
	});
	rmSync(podsEntryDir(env, entry.key), { recursive: true, force: true });
}

/** Delete one entry (row and directory). */
export function removePodsEntry(store: Store, env: Env, key: string): Result<PodsEntry> {
	const entry = getPodsEntry(store, key);
	if (!entry) return err(`no pods cache entry ${key}`);
	deleteEntry(store, env, entry);
	return ok(entry);
}

export type PrunePodsOptions = {
	/** keep the total apparent size at or under this, evicting least recently used first */
	maxBytes?: number;
	/** evict entries not used for longer than this */
	olderThanMs?: number;
	now: number;
	/** report only */
	dryRun?: boolean;
	/** keys locked right now: never pruned */
	live?: Set<string>;
};

function selectDoomed(all: PodsEntry[], oldestFirst: PodsEntry[], opts: PrunePodsOptions): Set<string> {
	const doomed = new Set<string>();
	for (const e of oldestFirst) {
		if (opts.olderThanMs !== undefined && opts.now - e.lastUsedAt > opts.olderThanMs) doomed.add(e.key);
	}
	if (opts.maxBytes === undefined) return doomed;
	let total = all.reduce((sum, e) => sum + (doomed.has(e.key) ? 0 : e.sizeBytes), 0);
	for (const e of oldestFirst) {
		if (total <= opts.maxBytes) break;
		if (doomed.has(e.key)) continue;
		doomed.add(e.key);
		total -= e.sizeBytes;
	}
	return doomed;
}

/**
 * Evict entries, least recently used first: everything older than `olderThanMs`, then the oldest until the rest fits
 * `maxBytes`. Sizes are apparent: entries share blocks with the checkouts cloned from them, so the real space freed is less.
 * Returns what was (or with `dryRun` would be) removed.
 */
export function prunePods(store: Store, env: Env, opts: PrunePodsOptions): PodsEntry[] {
	const oldestFirst = listPodsEntries(store)
		.filter((e) => !opts.live?.has(e.key))
		.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.key.localeCompare(b.key));
	const doomed = selectDoomed(listPodsEntries(store), oldestFirst, opts);
	const removed = oldestFirst.filter((e) => doomed.has(e.key));
	if (!opts.dryRun) for (const e of removed) deleteEntry(store, env, e);
	return removed;
}

/** Pods keys whose per-key install lock is held by a live process. */
export function livePodsKeys(store: Store, now: number, pidAlive: PidAlive): Set<string> {
	const keys = new Set<string>();
	for (const k of liveBuildLocks(store, now, pidAlive))
		if (k.startsWith(LOCK_PREFIX)) keys.add(k.slice(LOCK_PREFIX.length));
	return keys;
}

/** Apparent size of a tree (symlinks counted as links, not followed). */
export function treeSize(dir: string): number {
	let total = 0;
	const stack = [dir];
	for (let d = stack.pop(); d !== undefined; d = stack.pop()) {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(d, name);
			try {
				const st = lstatSync(path);
				if (st.isDirectory()) stack.push(path);
				else total += st.size;
			} catch {
				// vanished mid-walk
			}
		}
	}
	return total;
}
