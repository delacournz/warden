import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLeaseAlive, type PidAlive } from "./liveness";
import type { Lease, Owner, Platform, QueueEntry, Resource } from "./types";
import { resourceKey } from "./types";

/** `$WARDEN_HOME`, else `~/.warden`. */
export function wardenHome(env: Record<string, string | undefined> = process.env): string {
	if (env.WARDEN_HOME) return env.WARDEN_HOME;
	return join(env.HOME ?? "~", ".warden");
}

export function defaultDbPath(env: Record<string, string | undefined> = process.env): string {
	return join(wardenHome(env), "warden.db");
}

/**
 * Ordered schema migrations; index + 1 = `PRAGMA user_version` after applying. Append only — never
 * edit an entry that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
	`CREATE TABLE leases (
		id TEXT PRIMARY KEY,
		resource_key TEXT NOT NULL UNIQUE,
		resource TEXT NOT NULL,
		owner_key TEXT NOT NULL,
		owner TEXT NOT NULL,
		label TEXT,
		acquired_at INTEGER NOT NULL,
		heartbeat_at INTEGER NOT NULL,
		ttl_ms INTEGER NOT NULL,
		pid INTEGER
	);
	CREATE INDEX leases_owner ON leases(owner_key);
	CREATE TABLE devices (
		platform TEXT NOT NULL,
		id TEXT NOT NULL,
		name TEXT NOT NULL,
		profile TEXT,
		runtime TEXT,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL,
		PRIMARY KEY (platform, id)
	);`,
	`CREATE TABLE builds (
		project_key TEXT NOT NULL,
		platform TEXT NOT NULL,
		profile TEXT NOT NULL,
		hash TEXT NOT NULL,
		path TEXT NOT NULL,
		source TEXT NOT NULL,
		size INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER NOT NULL,
		PRIMARY KEY (project_key, platform, hash)
	);
	CREATE TABLE installs (
		platform TEXT NOT NULL,
		device_id TEXT NOT NULL,
		bundle_id TEXT NOT NULL,
		hash TEXT NOT NULL,
		installed_at INTEGER NOT NULL,
		PRIMARY KEY (platform, device_id, bundle_id)
	);`,
	`ALTER TABLE leases ADD COLUMN booted_by_owner INTEGER;
	CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
	`ALTER TABLE devices ADD COLUMN quarantined_at INTEGER;
	ALTER TABLE devices ADD COLUMN quarantine_reason TEXT;
	ALTER TABLE devices ADD COLUMN slimmed_at INTEGER;`,
	`ALTER TABLE leases ADD COLUMN heartbeat_ms INTEGER;`,
	`CREATE TABLE fingerprints (
		root TEXT NOT NULL,
		platform TEXT NOT NULL,
		variant TEXT NOT NULL,
		command TEXT NOT NULL,
		signature TEXT NOT NULL,
		native TEXT NOT NULL,
		computed_at INTEGER NOT NULL,
		PRIMARY KEY (root, platform, variant, command)
	);`,
	`ALTER TABLE installs ADD COLUMN container TEXT;
	ALTER TABLE installs ADD COLUMN exe_stamp TEXT;`,
	`CREATE TABLE boot_queue (
		id TEXT PRIMARY KEY,
		platform TEXT NOT NULL,
		profile TEXT NOT NULL,
		units REAL NOT NULL,
		priority INTEGER NOT NULL,
		enqueued_at INTEGER NOT NULL,
		heartbeat_at INTEGER NOT NULL,
		owner_key TEXT NOT NULL,
		owner TEXT NOT NULL,
		label TEXT,
		pid INTEGER
	);
	CREATE INDEX boot_queue_order ON boot_queue(priority, enqueued_at);`,
];

/** A queued claim that has not refreshed within this long is dead (its waiter polls every few seconds). */
export const QUEUE_TTL_MS = 60_000;

export function ownerKey(owner: Owner): string {
	switch (owner.kind) {
		case "agent":
			return `agent:${owner.sessionId}`;
		case "user":
			return `user:${owner.pid}`;
		case "ci":
			return `ci:${owner.runId}`;
	}
}

export type NewLease = {
	resource: Resource;
	owner: Owner;
	ttlMs: number;
	label?: string;
	pid?: number;
	bootedByOwner?: boolean;
};

/** A device warden created (sim) or launched (emulator). */
export type DeviceRecord = {
	platform: Platform;
	id: string;
	name: string;
	profile?: string;
	runtime?: string;
	createdAt: number;
	lastUsedAt: number;
	/** set when the device was reported bad (`release --bad`, failed health probe): never allocated until cleared */
	quarantinedAt?: number;
	quarantineReason?: string;
	/** set while the simulator's daemons are switched off (`sim slim`); cleared by `--restore` */
	slimmedAt?: number;
};

type LeaseRow = {
	id: string;
	resource: string;
	owner: string;
	label: string | null;
	acquired_at: number;
	heartbeat_at: number;
	ttl_ms: number;
	pid: number | null;
	booted_by_owner: number | null;
	heartbeat_ms: number | null;
};

type QueueRow = {
	id: string;
	platform: Platform;
	profile: string;
	units: number;
	priority: number;
	enqueued_at: number;
	heartbeat_at: number;
	owner: string;
	label: string | null;
	pid: number | null;
};

function toQueueEntry(row: QueueRow): QueueEntry {
	const entry: QueueEntry = {
		id: row.id,
		platform: row.platform,
		profile: row.profile,
		units: row.units,
		priority: row.priority,
		enqueuedAt: row.enqueued_at,
		heartbeatAt: row.heartbeat_at,
		owner: JSON.parse(row.owner) as Owner,
	};
	if (row.label !== null) entry.label = row.label;
	if (row.pid !== null) entry.pid = row.pid;
	return entry;
}

type DeviceRow = {
	platform: Platform;
	id: string;
	name: string;
	profile: string | null;
	runtime: string | null;
	created_at: number;
	last_used_at: number;
	quarantined_at: number | null;
	quarantine_reason: string | null;
	slimmed_at: number | null;
};

function toLease(row: LeaseRow): Lease {
	const lease: Lease = {
		id: row.id,
		resource: JSON.parse(row.resource) as Resource,
		owner: JSON.parse(row.owner) as Owner,
		acquiredAt: row.acquired_at,
		heartbeatAt: row.heartbeat_at,
		ttlMs: row.ttl_ms,
	};
	if (row.label !== null) lease.label = row.label;
	if (row.pid !== null) lease.pid = row.pid;
	if (row.booted_by_owner) lease.bootedByOwner = true;
	if (row.heartbeat_ms !== null) lease.heartbeatMs = row.heartbeat_ms;
	return lease;
}

function toDevice(row: DeviceRow): DeviceRecord {
	const device: DeviceRecord = {
		platform: row.platform,
		id: row.id,
		name: row.name,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	};
	if (row.profile !== null) device.profile = row.profile;
	if (row.runtime !== null) device.runtime = row.runtime;
	if (row.quarantined_at !== null) device.quarantinedAt = row.quarantined_at;
	if (row.quarantine_reason !== null) device.quarantineReason = row.quarantine_reason;
	if (row.slimmed_at !== null) device.slimmedAt = row.slimmed_at;
	return device;
}

export function newLeaseId(): string {
	return `l_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/**
 * The lease registry. One sqlite file (WAL) shared by every warden process on the machine;
 * `transaction` runs under `BEGIN IMMEDIATE`, which is the cross-process mutex for claims.
 */
export class Store {
	readonly db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	close(): void {
		this.db.close();
	}

	/** Run `fn` under `BEGIN IMMEDIATE` (write lock taken up front). Nested calls join the outer txn. */
	transaction<T>(fn: () => T): T {
		if (this.db.inTransaction) return fn();
		return this.db.transaction(fn).immediate();
	}

	insertLease(input: NewLease, now: number): Lease {
		const lease: Lease = {
			id: newLeaseId(),
			resource: input.resource,
			owner: input.owner,
			acquiredAt: now,
			heartbeatAt: now,
			ttlMs: input.ttlMs,
		};
		if (input.label !== undefined) lease.label = input.label;
		if (input.pid !== undefined) lease.pid = input.pid;
		if (input.bootedByOwner) lease.bootedByOwner = true;
		this.db
			.query(
				`INSERT INTO leases (id, resource_key, resource, owner_key, owner, label, acquired_at, heartbeat_at, ttl_ms, pid, booted_by_owner)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				lease.id,
				resourceKey(lease.resource),
				JSON.stringify(lease.resource),
				ownerKey(lease.owner),
				JSON.stringify(lease.owner),
				lease.label ?? null,
				now,
				now,
				lease.ttlMs,
				lease.pid ?? null,
				lease.bootedByOwner ? 1 : null
			);
		return lease;
	}

	/** Record that this lease's owner booted its device (claim boot/create, hook saw it shut down). */
	markBootedByOwner(id: string): void {
		this.db.query("UPDATE leases SET booted_by_owner = 1 WHERE id = ?").run(id);
	}

	/** Record the process a lease now lives with (an emulator launched after its port was leased). */
	setLeasePid(id: string, pid: number): void {
		this.db.query("UPDATE leases SET pid = ? WHERE id = ?").run(pid, id);
	}

	getMeta(key: string): string | undefined {
		return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value;
	}

	setMeta(key: string, value: string): void {
		this.db
			.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}

	deleteMeta(key: string): void {
		this.db.query("DELETE FROM meta WHERE key = ?").run(key);
	}

	getLease(id: string): Lease | undefined {
		const row = this.db.query<LeaseRow, [string]>("SELECT * FROM leases WHERE id = ?").get(id);
		return row ? toLease(row) : undefined;
	}

	listLeases(): Lease[] {
		return this.db.query<LeaseRow, []>("SELECT * FROM leases ORDER BY acquired_at, id").all().map(toLease);
	}

	listLeasesByOwner(owner: Owner): Lease[] {
		return this.db
			.query<LeaseRow, [string]>("SELECT * FROM leases WHERE owner_key = ? ORDER BY acquired_at, id")
			.all(ownerKey(owner))
			.map(toLease);
	}

	findLeaseByResource(resource: Resource): Lease | undefined {
		const row = this.db
			.query<LeaseRow, [string]>("SELECT * FROM leases WHERE resource_key = ?")
			.get(resourceKey(resource));
		return row ? toLease(row) : undefined;
	}

	deleteLeases(ids: readonly string[]): number {
		if (ids.length === 0) return 0;
		const stmt = this.db.query("DELETE FROM leases WHERE id = ?");
		return this.transaction(() => ids.reduce((n, id) => n + stmt.run(id).changes, 0));
	}

	/**
	 * Stamp `heartbeat_at = now` on `ids`; returns how many leases were updated (fewer than `ids` = some
	 * were released). `periodMs` (the holder's heartbeat interval) marks them supervised: with a pid,
	 * a dead pid makes them stale after `LOST_HEARTBEATS` periods instead of the TTL.
	 */
	heartbeat(ids: readonly string[], now: number, periodMs?: number): number {
		if (ids.length === 0) return 0;
		const stmt = this.db.query(
			"UPDATE leases SET heartbeat_at = ?, heartbeat_ms = COALESCE(?, heartbeat_ms) WHERE id = ?"
		);
		return this.transaction(() => ids.reduce((n, id) => n + stmt.run(now, periodMs ?? null, id).changes, 0));
	}

	/** Delete leases that are not alive (`isLeaseAlive`: pid dead AND heartbeat expired). Returns reclaimed ids. */
	reclaimStale(now: number, pidAlive: PidAlive): string[] {
		return this.transaction(() => {
			const stale = this.listLeases()
				.filter((l) => !isLeaseAlive(l, now, pidAlive))
				.map((l) => l.id);
			this.deleteLeases(stale);
			return stale;
		});
	}

	/** Insert a queue row; an existing id keeps its `enqueuedAt` (queue age) and updates the rest. */
	enqueue(entry: QueueEntry): QueueEntry {
		return this.transaction(() => {
			this.db
				.query(
					`INSERT INTO boot_queue (id, platform, profile, units, priority, enqueued_at, heartbeat_at, owner_key, owner, label, pid)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (id) DO UPDATE SET platform = excluded.platform, profile = excluded.profile, units = excluded.units,
					   heartbeat_at = excluded.heartbeat_at, label = excluded.label, pid = excluded.pid`
				)
				.run(
					entry.id,
					entry.platform,
					entry.profile,
					entry.units,
					entry.priority,
					entry.enqueuedAt,
					entry.heartbeatAt,
					ownerKey(entry.owner),
					JSON.stringify(entry.owner),
					entry.label ?? null,
					entry.pid ?? null
				);
			const row = this.db.query<QueueRow, [string]>("SELECT * FROM boot_queue WHERE id = ?").get(entry.id);
			if (!row) throw new Error(`boot_queue row ${entry.id} vanished`);
			return toQueueEntry(row);
		});
	}

	/** Stamp `heartbeat_at`; false when the row is gone (reclaimed or dequeued). */
	refreshQueue(id: string, now: number): boolean {
		return this.db.query("UPDATE boot_queue SET heartbeat_at = ? WHERE id = ?").run(now, id).changes > 0;
	}

	dequeue(id: string): boolean {
		return this.db.query("DELETE FROM boot_queue WHERE id = ?").run(id).changes > 0;
	}

	/** Raw insertion order (`enqueued_at`, id); use `queueOrder` for admission order. */
	listQueue(): QueueEntry[] {
		return this.db.query<QueueRow, []>("SELECT * FROM boot_queue ORDER BY enqueued_at, id").all().map(toQueueEntry);
	}

	/** Delete queue rows whose waiter is gone: pid dead, or heartbeat older than `QUEUE_TTL_MS`. */
	reclaimStaleQueue(now: number, pidAlive: PidAlive): string[] {
		return this.transaction(() => {
			const stale = this.listQueue()
				.filter((e) => now - e.heartbeatAt > QUEUE_TTL_MS || (e.pid !== undefined && !pidAlive(e.pid)))
				.map((e) => e.id);
			const stmt = this.db.query("DELETE FROM boot_queue WHERE id = ?");
			for (const id of stale) stmt.run(id);
			return stale;
		});
	}

	recordDevice(device: Omit<DeviceRecord, "createdAt" | "lastUsedAt">, now: number): void {
		this.db
			.query(
				`INSERT INTO devices (platform, id, name, profile, runtime, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (platform, id) DO UPDATE SET name = excluded.name, profile = excluded.profile, runtime = excluded.runtime, last_used_at = excluded.last_used_at`
			)
			.run(device.platform, device.id, device.name, device.profile ?? null, device.runtime ?? null, now, now);
	}

	listDevices(platform?: Platform): DeviceRecord[] {
		const rows =
			platform === undefined
				? this.db.query<DeviceRow, []>("SELECT * FROM devices ORDER BY platform, name").all()
				: this.db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE platform = ? ORDER BY name").all(platform);
		return rows.map(toDevice);
	}

	touchDevice(platform: Platform, id: string, now: number): void {
		this.db.query("UPDATE devices SET last_used_at = ? WHERE platform = ? AND id = ?").run(now, platform, id);
	}

	/** Quarantine a warden device (recording it first when only its name marked it ours). */
	quarantineDevice(
		device: Omit<DeviceRecord, "createdAt" | "lastUsedAt" | "quarantinedAt" | "quarantineReason" | "slimmedAt">,
		reason: string | undefined,
		now: number
	): void {
		this.transaction(() => {
			this.db
				.query(
					`INSERT INTO devices (platform, id, name, profile, runtime, created_at, last_used_at, quarantined_at, quarantine_reason)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (platform, id) DO UPDATE SET quarantined_at = excluded.quarantined_at, quarantine_reason = excluded.quarantine_reason`
				)
				.run(
					device.platform,
					device.id,
					device.name,
					device.profile ?? null,
					device.runtime ?? null,
					now,
					now,
					now,
					reason ?? null
				);
		});
	}

	/** Clear quarantine on every recorded device with this id (any platform); returns how many were cleared. */
	unquarantineDevice(id: string): number {
		return this.db
			.query(
				"UPDATE devices SET quarantined_at = NULL, quarantine_reason = NULL WHERE id = ? AND quarantined_at IS NOT NULL"
			)
			.run(id).changes;
	}

	/** Record (`at` set) or clear (`at` undefined) that a recorded device's daemons are slimmed. */
	setSlimmed(platform: Platform, id: string, at: number | undefined): void {
		this.db.query("UPDATE devices SET slimmed_at = ? WHERE platform = ? AND id = ?").run(at ?? null, platform, id);
	}

	forgetDevice(platform: Platform, id: string): void {
		this.db.query("DELETE FROM devices WHERE platform = ? AND id = ?").run(platform, id);
	}

	/**
	 * What a `warden gc` pass could find to do, from the store alone (no simulator is asked):
	 * - `staleLeases`: leases whose heartbeat expired and whose process is gone;
	 * - `idleDevices`: recorded devices nobody holds that went idle (unused for `idleMs`) after the
	 *   last pass (`last_gc_at`). Whether one is still booted only the provider knows; a pass that
	 *   ran after the device went idle has dealt with it, so it is not work again until it is used.
	 */
	gcWork(now: number, idleMs: number, pidAlive: PidAlive): { staleLeases: number; idleDevices: number } {
		const staleLeases = this.listLeases().filter((l) => !isLeaseAlive(l, now, pidAlive)).length;
		const lastGc = Number(this.getMeta("last_gc_at") ?? 0);
		const row = this.db
			.query<{ n: number }, [number, number, number]>(
				`SELECT COUNT(*) AS n FROM devices d
				 WHERE d.last_used_at <= ?1 - ?2 AND d.last_used_at + ?2 > ?3
				   AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.resource_key = 'device:' || d.platform || ':' || d.id)`
			)
			.get(now, idleMs, lastGc);
		return { staleLeases, idleDevices: row?.n ?? 0 };
	}
}

function migrate(db: Database): void {
	const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
	const current = row?.user_version ?? 0;
	if (current >= MIGRATIONS.length) return;
	db.transaction(() => {
		const again = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
		for (let v = again; v < MIGRATIONS.length; v++) {
			const sql = MIGRATIONS[v];
			if (sql !== undefined) db.exec(sql);
		}
		db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
	}).immediate();
}

/** Open (creating + migrating) the store at `path`, default `$WARDEN_HOME/warden.db`. */
export function openStore(path: string = defaultDbPath()): Store {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true, strict: true });
	db.exec("PRAGMA busy_timeout = 15000");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA foreign_keys = ON");
	migrate(db);
	return new Store(db);
}
