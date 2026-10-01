import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Store } from "../store";
import { wardenHome } from "../store";
import type { Platform } from "../types";
import { safeKey } from "./project-key";

/** Where a cached build came from. */
export type BuildSource = "eas" | "build" | "import" | "legacy";

export type BuildRecord = {
	projectKey: string;
	platform: Platform;
	profile: string;
	hash: string;
	/** absolute path to the `.app` dir / `.apk` */
	path: string;
	source: BuildSource;
	/** bytes on disk */
	size: number;
	createdAt: number;
	lastUsedAt: number;
};

export type InstallRecord = {
	platform: Platform;
	deviceId: string;
	bundleId: string;
	hash: string;
	installedAt: number;
};

type BuildRow = {
	project_key: string;
	platform: Platform;
	profile: string;
	hash: string;
	path: string;
	source: BuildSource;
	size: number;
	created_at: number;
	last_used_at: number;
};

type InstallRow = { platform: Platform; device_id: string; bundle_id: string; hash: string; installed_at: number };

function toBuild(row: BuildRow): BuildRecord {
	return {
		projectKey: row.project_key,
		platform: row.platform,
		profile: row.profile,
		hash: row.hash,
		path: row.path,
		source: row.source,
		size: row.size,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	};
}

/** `$WARDEN_HOME/builds`. */
export function buildsRoot(env: Record<string, string | undefined>): string {
	return join(wardenHome(env), "builds");
}

/** `$WARDEN_HOME/builds/<safe projectKey>/<platform>/<hash>`. */
export function buildDir(
	env: Record<string, string | undefined>,
	key: string,
	platform: Platform,
	hash: string
): string {
	return join(buildsRoot(env), safeKey(key), platform, hash);
}

/** Artifact extension per platform. */
export function artifactExt(platform: Platform): ".app" | ".apk" {
	return platform === "ios" ? ".app" : ".apk";
}

/** First `*.app` (iOS) / `*.apk` (Android) directly inside `dir`. */
export function findArtifact(dir: string, platform: Platform): string | undefined {
	if (!existsSync(dir)) return undefined;
	const name = readdirSync(dir)
		.sort()
		.find((n) => n.endsWith(artifactExt(platform)));
	return name ? join(dir, name) : undefined;
}

/** Recursive on-disk size (symlinks counted as links, not followed). */
export function diskSize(path: string): number {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return 0;
	if (!stat.isDirectory()) return stat.size;
	return readdirSync(path).reduce((sum, name) => sum + diskSize(join(path, name)), 0);
}

export function upsertBuild(store: Store, record: BuildRecord): void {
	store.db
		.query(
			`INSERT INTO builds (project_key, platform, profile, hash, path, source, size, created_at, last_used_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (project_key, platform, hash) DO UPDATE SET profile = excluded.profile, path = excluded.path,
			   source = excluded.source, size = excluded.size, created_at = excluded.created_at, last_used_at = excluded.last_used_at`
		)
		.run(
			record.projectKey,
			record.platform,
			record.profile,
			record.hash,
			record.path,
			record.source,
			record.size,
			record.createdAt,
			record.lastUsedAt
		);
}

export function getBuild(store: Store, key: string, platform: Platform, hash: string): BuildRecord | undefined {
	const row = store.db
		.query<BuildRow, [string, string, string]>(
			"SELECT * FROM builds WHERE project_key = ? AND platform = ? AND hash = ?"
		)
		.get(key, platform, hash);
	return row ? toBuild(row) : undefined;
}

export function listBuilds(store: Store): BuildRecord[] {
	return store.db
		.query<BuildRow, []>("SELECT * FROM builds ORDER BY last_used_at DESC, project_key, platform, hash")
		.all()
		.map(toBuild);
}

export function touchBuild(store: Store, key: string, platform: Platform, hash: string, now: number): void {
	store.db
		.query("UPDATE builds SET last_used_at = ? WHERE project_key = ? AND platform = ? AND hash = ?")
		.run(now, key, platform, hash);
}

export function deleteBuildRecord(store: Store, key: string, platform: Platform, hash: string): void {
	store.db.query("DELETE FROM builds WHERE project_key = ? AND platform = ? AND hash = ?").run(key, platform, hash);
}

/**
 * Cached build whose artifact still exists (touched: `lastUsedAt = now`). A record whose files
 * vanished is dropped and reported as a miss.
 */
export function cachedBuild(
	store: Store,
	key: string,
	platform: Platform,
	hash: string,
	now: number
): BuildRecord | undefined {
	const record = getBuild(store, key, platform, hash);
	if (!record) return undefined;
	if (!existsSync(record.path)) {
		deleteBuildRecord(store, key, platform, hash);
		return undefined;
	}
	touchBuild(store, key, platform, hash, now);
	return { ...record, lastUsedAt: now };
}

export type StoreArtifactInput = {
	store: Store;
	env: Record<string, string | undefined>;
	projectKey: string;
	platform: Platform;
	profile: string;
	hash: string;
	/** existing `.app` dir / `.apk` */
	artifact: string;
	source: BuildSource;
	/** move instead of copy (eas-cli's temp download); falls back to copy across filesystems */
	move?: boolean;
	now: number;
};

/** Put `artifact` into the cache dir for (project, platform, hash) and register it. */
export async function storeArtifact(input: StoreArtifactInput): AsyncResult<BuildRecord> {
	const ext = artifactExt(input.platform);
	if (!input.artifact.endsWith(ext) || !existsSync(input.artifact)) {
		return err(`not a ${input.platform} build (${ext}): ${input.artifact}`);
	}
	const dir = buildDir(input.env, input.projectKey, input.platform, input.hash);
	const target = join(dir, basename(input.artifact));
	try {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		let moved = false;
		if (input.move) {
			try {
				renameSync(input.artifact, target);
				moved = true;
			} catch {
				moved = false;
			}
		}
		if (!moved) await cp(input.artifact, target, { recursive: true, verbatimSymlinks: true });
	} catch (error) {
		return err(`caching ${input.artifact}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const record: BuildRecord = {
		projectKey: input.projectKey,
		platform: input.platform,
		profile: input.profile,
		hash: input.hash,
		path: target,
		source: input.source,
		size: diskSize(target),
		createdAt: input.now,
		lastUsedAt: input.now,
	};
	upsertBuild(input.store, record);
	return ok(record);
}

/** Remove a cached build's files and record. */
export function removeBuild(store: Store, env: Record<string, string | undefined>, record: BuildRecord): void {
	rmSync(buildDir(env, record.projectKey, record.platform, record.hash), { recursive: true, force: true });
	deleteBuildRecord(store, record.projectKey, record.platform, record.hash);
}

/** Artifact for `hash` in any legacy cache root (`<dir>/<hash>/*.app|*.apk`). */
export function findLegacyArtifact(dirs: readonly string[], platform: Platform, hash: string): string | undefined {
	for (const dir of dirs) {
		const hit = findArtifact(join(dir, hash), platform);
		if (hit) return hit;
	}
	return undefined;
}

export function recordInstall(store: Store, install: InstallRecord): void {
	store.db
		.query(
			`INSERT INTO installs (platform, device_id, bundle_id, hash, installed_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (platform, device_id, bundle_id) DO UPDATE SET hash = excluded.hash, installed_at = excluded.installed_at`
		)
		.run(install.platform, install.deviceId, install.bundleId, install.hash, install.installedAt);
}

export function getInstall(
	store: Store,
	platform: Platform,
	deviceId: string,
	bundleId: string
): InstallRecord | undefined {
	const row = store.db
		.query<InstallRow, [string, string, string]>(
			"SELECT * FROM installs WHERE platform = ? AND device_id = ? AND bundle_id = ?"
		)
		.get(platform, deviceId, bundleId);
	return row
		? {
				platform: row.platform,
				deviceId: row.device_id,
				bundleId: row.bundle_id,
				hash: row.hash,
				installedAt: row.installed_at,
			}
		: undefined;
}

export function forgetInstall(store: Store, platform: Platform, deviceId: string, bundleId: string): void {
	store.db
		.query("DELETE FROM installs WHERE platform = ? AND device_id = ? AND bundle_id = ?")
		.run(platform, deviceId, bundleId);
}
