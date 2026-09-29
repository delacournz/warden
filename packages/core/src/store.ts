import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLeaseAlive, type PidAlive } from "./liveness";
import type { Lease, Owner, Platform, Resource } from "./types";
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
];

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
};

type DeviceRow = {
	platform: Platform;
	id: string;
	name: string;
	profile: string | null;
	runtime: string | null;
	created_at: number;
	last_used_at: number;
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
		this.db
			.query(
				`INSERT INTO leases (id, resource_key, resource, owner_key, owner, label, acquired_at, heartbeat_at, ttl_ms, pid)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
				lease.pid ?? null
			);
		return lease;
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

	heartbeat(ids: readonly string[], now: number): number {
		if (ids.length === 0) return 0;
		const stmt = this.db.query("UPDATE leases SET heartbeat_at = ? WHERE id = ?");
		return this.transaction(() => ids.reduce((n, id) => n + stmt.run(now, id).changes, 0));
	}

	/** Delete leases whose pid is dead AND heartbeat expired. Returns reclaimed ids. */
	reclaimStale(now: number, pidAlive: PidAlive): string[] {
		return this.transaction(() => {
			const stale = this.listLeases()
				.filter((l) => !isLeaseAlive(l, now, pidAlive))
				.map((l) => l.id);
			this.deleteLeases(stale);
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

	forgetDevice(platform: Platform, id: string): void {
		this.db.query("DELETE FROM devices WHERE platform = ? AND id = ?").run(platform, id);
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
	db.exec("PRAGMA foreign_keys = ON");
	migrate(db);
	return new Store(db);
}
