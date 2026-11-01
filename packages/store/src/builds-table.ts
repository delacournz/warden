import type { Store } from "./store";
import type { Platform } from "./types";

/**
 * Typed access to the `builds` / `installs` / `fingerprints` tables. The schema (and every migration) is owned by
 * `store.ts`; the build cache in `@delacour/warden-builds` goes through these helpers and holds no SQL.
 */

/** Where a cached build came from. */
export type BuildSource = "eas" | "build" | "import" | "legacy";

/** What every cached build records, whatever its kind. */
export type BuildBase = {
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

/**
 * A cached build, discriminated on `kind`:
 * - `legacy` (`kind` unset): a pre-kind row, flat `<platform>/<hash>/`; found through its stored `path`, never moved.
 * - `dev`: `<nativeFp>/dev/`, hash `<nativeFp>:dev`.
 * - `simulator-base`: `<nativeFp>/simulator/base/`, hash `<nativeFp>:base`; Release, no JS bundle.
 * - `simulator-repack`: `<nativeFp>/simulator/repacks/<jsKey>/`, hash `<nativeFp>:<jsKey>`; a clone of a base with a bundle.
 * - `release`: `<nativeFp>/release/<jsKey>/`, hash `<nativeFp>:release:<jsKey>`.
 * - a `dev` / `release` build for a physical iPhone (`BuildTarget` `device`) lives under `<nativeFp>/device/<team>/…` and
 *   its hash carries `:device-<team>` after the fingerprint (`<nativeFp>:device-<team>:release:<jsKey>`).
 * `worktree` / `branch` of a repack are metadata (what `warden builds` lists), never part of a key.
 */
export type BuildRecord =
	| (BuildBase & { kind?: "legacy" })
	| (BuildBase & { kind: "dev" })
	| (BuildBase & { kind: "simulator-base" })
	| (BuildBase & {
			kind: "simulator-repack";
			/** hash of the `simulator-base` record this repack was cloned from */
			baseHash: string;
			jsKey: string;
			worktree?: string;
			branch?: string;
	  })
	| (BuildBase & { kind: "release"; jsKey: string });

export type SimulatorRepackRecord = Extract<BuildRecord, { kind: "simulator-repack" }>;
export type SimulatorBaseRecord = Extract<BuildRecord, { kind: "simulator-base" }>;

export type InstallRecord = {
	platform: Platform;
	deviceId: string;
	bundleId: string;
	hash: string;
	installedAt: number;
	/** iOS: the bundle container `get_app_container` named right after this install (17-7) */
	container?: string;
	/** iOS: `ino:mtime` of the container's executable then; with `container` it identifies this install without `plutil` */
	exeStamp?: string;
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
	kind: string;
	base_hash: string | null;
	js_key: string | null;
	worktree: string | null;
	branch: string | null;
};

type InstallRow = {
	platform: Platform;
	device_id: string;
	bundle_id: string;
	hash: string;
	installed_at: number;
	container: string | null;
	exe_stamp: string | null;
};

function toBuild(row: BuildRow): BuildRecord {
	const base: BuildBase = {
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
	switch (row.kind) {
		case "dev":
			return { ...base, kind: "dev" };
		case "simulator-base":
			return { ...base, kind: "simulator-base" };
		case "simulator-repack":
			return {
				...base,
				kind: "simulator-repack",
				baseHash: row.base_hash ?? "",
				jsKey: row.js_key ?? "",
				...(row.worktree !== null ? { worktree: row.worktree } : {}),
				...(row.branch !== null ? { branch: row.branch } : {}),
			};
		case "release":
			return { ...base, kind: "release", jsKey: row.js_key ?? "" };
		default:
			return base;
	}
}

export function upsertBuild(store: Store, record: BuildRecord): void {
	const repack = record.kind === "simulator-repack" ? record : undefined;
	const jsKey = repack?.jsKey ?? (record.kind === "release" ? record.jsKey : undefined);
	store.db
		.query(
			`INSERT INTO builds (project_key, platform, profile, hash, path, source, size, created_at, last_used_at, kind, base_hash, js_key, worktree, branch)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (project_key, platform, hash) DO UPDATE SET profile = excluded.profile, path = excluded.path,
			   source = excluded.source, size = excluded.size, created_at = excluded.created_at, last_used_at = excluded.last_used_at,
			   kind = excluded.kind, base_hash = excluded.base_hash, js_key = excluded.js_key,
			   worktree = excluded.worktree, branch = excluded.branch`
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
			record.lastUsedAt,
			record.kind ?? "legacy",
			repack?.baseHash ?? null,
			jsKey ?? null,
			repack?.worktree ?? null,
			repack?.branch ?? null
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

/** Mark every build row pointing at `path` (a build and its aliases share one) as used at `now`. */
export function touchBuildsByPath(store: Store, path: string, now: number): void {
	store.db.query("UPDATE builds SET last_used_at = ? WHERE path = ?").run(now, path);
}

export function deleteBuildRecord(store: Store, key: string, platform: Platform, hash: string): void {
	store.db.query("DELETE FROM builds WHERE project_key = ? AND platform = ? AND hash = ?").run(key, platform, hash);
}

/** Total bytes of the cached builds (one aggregate query, no fs walk). */
export function totalBuildBytes(store: Store): number {
	return store.db.query<{ total: number }, []>("SELECT COALESCE(SUM(size), 0) AS total FROM builds").get()?.total ?? 0;
}

export function recordInstall(store: Store, install: InstallRecord): void {
	store.db
		.query(
			`INSERT INTO installs (platform, device_id, bundle_id, hash, installed_at, container, exe_stamp) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (platform, device_id, bundle_id) DO UPDATE SET hash = excluded.hash, installed_at = excluded.installed_at,
			   container = excluded.container, exe_stamp = excluded.exe_stamp`
		)
		.run(
			install.platform,
			install.deviceId,
			install.bundleId,
			install.hash,
			install.installedAt,
			install.container ?? null,
			install.exeStamp ?? null
		);
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
	if (!row) return undefined;
	const install: InstallRecord = {
		platform: row.platform,
		deviceId: row.device_id,
		bundleId: row.bundle_id,
		hash: row.hash,
		installedAt: row.installed_at,
	};
	if (row.container !== null) install.container = row.container;
	if (row.exe_stamp !== null) install.exeStamp = row.exe_stamp;
	return install;
}

export function forgetInstall(store: Store, platform: Platform, deviceId: string, bundleId: string): void {
	store.db
		.query("DELETE FROM installs WHERE platform = ? AND device_id = ? AND bundle_id = ?")
		.run(platform, deviceId, bundleId);
}

/** Bundle ids warden has installed on one device (the allowlist of what it may uninstall or wipe on a phone). */
export function installedBundleIds(store: Store, platform: Platform, deviceId: string): string[] {
	return store.db
		.query<{ bundle_id: string }, [string, string]>(
			"SELECT bundle_id FROM installs WHERE platform = ? AND device_id = ? ORDER BY bundle_id"
		)
		.all(platform, deviceId)
		.map((row) => row.bundle_id);
}

/** Forget every install record of `platform` at one of `hashes` (their build is gone); how many there were. */
export function forgetInstallsAt(store: Store, platform: Platform, hashes: readonly string[], dryRun = false): number {
	if (hashes.length === 0) return 0;
	const marks = hashes.map(() => "?").join(", ");
	const where = `WHERE platform = ? AND hash IN (${marks})`;
	const count =
		store.db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM installs ${where}`).get(platform, ...hashes)
			?.n ?? 0;
	if (!dryRun) store.db.query(`DELETE FROM installs ${where}`).run(platform, ...hashes);
	return count;
}

/** A `fingerprints` row's identity: project root, platform, variant, fingerprint command (JSON). */
export type FingerprintMemoKey = readonly [root: string, platform: string, variant: string, command: string];

export type FingerprintMemoRow = { signature: string; native: string; computedAt: number };

export function getFingerprintMemoRow(store: Store, key: FingerprintMemoKey): FingerprintMemoRow | undefined {
	const row = store.db
		.query<{ signature: string; native: string; computed_at: number }, [string, string, string, string]>(
			"SELECT signature, native, computed_at FROM fingerprints WHERE root = ? AND platform = ? AND variant = ? AND command = ?"
		)
		.get(...key);
	return row ? { signature: row.signature, native: row.native, computedAt: row.computed_at } : undefined;
}

export function putFingerprintMemoRow(
	store: Store,
	key: FingerprintMemoKey,
	signature: string,
	native: string,
	computedAt: number
): void {
	store.db
		.query(
			`INSERT INTO fingerprints (root, platform, variant, command, signature, native, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (root, platform, variant, command) DO UPDATE SET signature = excluded.signature, native = excluded.native,
			   computed_at = excluded.computed_at`
		)
		.run(...key, signature, native, computedAt);
}
