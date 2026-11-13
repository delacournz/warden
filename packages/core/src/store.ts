import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type EventFilter,
	INTERNAL_LEASE_LABELS,
	insertLeaseEvent,
	type LeaseEvent,
	type NewLeaseEvent,
	pruneLeaseEvents,
	queryLeaseEvents,
} from "./lease-events";
import { isLeaseAlive, type PidAlive } from "./liveness";
import { isWaitReason, type WaitReason } from "./queue";
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

/** An owner's idempotency key and the claim it created (one row per key, however many leases the claim holds). */
export type ClaimKey = {
	ownerKey: string;
	key: string;
	claimId: string;
	platform: string;
	profile: string;
	count: number;
	ready: boolean;
};

type ClaimKeyRow = {
	owner_key: string;
	key: string;
	claim_id: string;
	platform: string;
	profile: string;
	count: number;
	ready: number;
};

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
	`ALTER TABLE leases ADD COLUMN shared INTEGER;`,
	`ALTER TABLE builds ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy';
	ALTER TABLE builds ADD COLUMN base_hash TEXT;
	ALTER TABLE builds ADD COLUMN js_key TEXT;
	ALTER TABLE builds ADD COLUMN worktree TEXT;
	ALTER TABLE builds ADD COLUMN branch TEXT;`,
	`CREATE TABLE lease_conditions (
		lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
		area TEXT NOT NULL,
		json TEXT NOT NULL,
		owned TEXT NOT NULL DEFAULT '[]',
		set_at INTEGER NOT NULL,
		PRIMARY KEY (lease_id, area)
	);`,
	// a device lease deleted by any path (stale reclaim, eviction, rollback, an older binary) takes its
	// conditions with it by cascade; the trigger parks them here first so the next claim can undo them
	`CREATE TABLE orphan_conditions (
		platform TEXT NOT NULL,
		device_id TEXT NOT NULL,
		area TEXT NOT NULL,
		lease_id TEXT NOT NULL,
		json TEXT NOT NULL,
		owned TEXT NOT NULL DEFAULT '[]',
		set_at INTEGER NOT NULL,
		orphaned_at INTEGER NOT NULL,
		PRIMARY KEY (platform, device_id, area)
	);
	CREATE TRIGGER leases_orphan_conditions BEFORE DELETE ON leases
	WHEN json_extract(OLD.resource, '$.kind') = 'device' AND json_extract(OLD.resource, '$.id') NOT LIKE 'pending:%'
	BEGIN
		INSERT OR REPLACE INTO orphan_conditions (platform, device_id, area, lease_id, json, owned, set_at, orphaned_at)
		SELECT json_extract(OLD.resource, '$.platform'), json_extract(OLD.resource, '$.id'), c.area, OLD.id, c.json, c.owned, c.set_at,
			CAST(strftime('%s', 'now') AS INTEGER) * 1000
		FROM lease_conditions c WHERE c.lease_id = OLD.id;
	END;`,
	`ALTER TABLE devices ADD COLUMN persistent_at INTEGER;`,
	`ALTER TABLE boot_queue ADD COLUMN reason TEXT;`,
	`ALTER TABLE leases ADD COLUMN claim_id TEXT;
	ALTER TABLE boot_queue ADD COLUMN claim_id TEXT;`,
	`CREATE TABLE lease_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL,
		type TEXT NOT NULL,
		lease_id TEXT,
		resource_key TEXT,
		owner_key TEXT,
		label TEXT,
		claim_id TEXT,
		data TEXT NOT NULL DEFAULT '{}'
	);
	CREATE INDEX lease_events_at ON lease_events(at);
	CREATE INDEX lease_events_lease ON lease_events(lease_id);
	CREATE INDEX lease_events_owner ON lease_events(owner_key, at);
	CREATE INDEX lease_events_claim ON lease_events(claim_id);`,
	`CREATE TABLE claim_keys (
		owner_key TEXT NOT NULL,
		key TEXT NOT NULL,
		claim_id TEXT NOT NULL,
		platform TEXT NOT NULL,
		profile TEXT NOT NULL,
		count INTEGER NOT NULL,
		ready INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (owner_key, key)
	);
	CREATE INDEX claim_keys_claim ON claim_keys(claim_id);`,
	`CREATE TABLE hosts (
		name TEXT PRIMARY KEY,
		json TEXT NOT NULL,
		added_at INTEGER NOT NULL
	);
	CREATE TABLE host_grants (
		fingerprint TEXT PRIMARY KEY,
		machine_id TEXT NOT NULL,
		user TEXT NOT NULL,
		public_key TEXT NOT NULL,
		added_at INTEGER NOT NULL
	);`,
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
		case "host":
			return `host:${owner.machineId}`;
	}
}

/** Why leases are being deleted when it is history worth logging (see `Store.deleteLeases`). */
export type LeaseEnd = { type: "released" | "expired"; now: number };

export type NewLease = {
	resource: Resource;
	owner: Owner;
	ttlMs: number;
	label?: string;
	pid?: number;
	bootedByOwner?: boolean;
	shared?: boolean;
	claimId?: string;
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
	/** set when `warden dev` took the sim: kept on shutdown (not ephemeral) so installs and logins survive */
	persistentAt?: number;
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
	shared: number | null;
	claim_id: string | null;
};

type GrantedRow = {
	resource_key: string | null;
	owner_key: string | null;
	label: string | null;
	claim_id: string | null;
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
	reason: string | null;
	claim_id: string | null;
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
	if (row.reason !== null && isWaitReason(row.reason)) entry.reason = row.reason;
	if (row.claim_id !== null) entry.claimId = row.claim_id;
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
	persistent_at: number | null;
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
	if (row.shared) lease.shared = true;
	if (row.claim_id !== null) lease.claimId = row.claim_id;
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
	if (row.persistent_at !== null) device.persistentAt = row.persistent_at;
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
		if (input.shared) lease.shared = true;
		if (input.claimId !== undefined) lease.claimId = input.claimId;
		this.db
			.query(
				`INSERT INTO leases (id, resource_key, resource, owner_key, owner, label, acquired_at, heartbeat_at, ttl_ms, pid, booted_by_owner, shared, claim_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
				lease.bootedByOwner ? 1 : null,
				lease.shared ? 1 : null,
				lease.claimId ?? null
			);
		return lease;
	}

	/** Mark leases shared (`Lease.shared`): `warden dev` on the device leases it just claimed. */
	markShared(ids: readonly string[]): void {
		if (ids.length === 0) return;
		const stmt = this.db.query("UPDATE leases SET shared = 1 WHERE id = ?");
		this.transaction(() => {
			for (const id of ids) stmt.run(id);
		});
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

	/**
	 * Delete leases. With `end`, a device lease that was granted (has a `granted` event) also logs `end.type`
	 * in the same transaction. Without it nothing is logged: rollbacks, create placeholders, eviction holds,
	 * ports and build locks are not lease history.
	 */
	deleteLeases(ids: readonly string[], end?: LeaseEnd): number {
		if (ids.length === 0) return 0;
		const stmt = this.db.query("DELETE FROM leases WHERE id = ?");
		return this.transaction(() =>
			ids.reduce((n, id) => {
				const lease = end ? this.getLease(id) : undefined;
				const changes = stmt.run(id).changes;
				if (changes > 0 && lease && end) this.recordLeaseEnd(lease, end);
				return n + changes;
			}, 0)
		);
	}

	private recordLeaseEnd(lease: Lease, end: LeaseEnd): void {
		if (lease.resource.kind !== "device" || lease.resource.id.startsWith("pending:")) return;
		if (lease.label !== undefined && INTERNAL_LEASE_LABELS.includes(lease.label)) return;
		const granted = this.db
			.query<{ at: number }, [string]>("SELECT at FROM lease_events WHERE lease_id = ? AND type = 'granted' LIMIT 1")
			.get(lease.id);
		if (!granted) return;
		this.recordEvent({
			at: end.now,
			type: end.type,
			data: { heldMs: Math.max(0, end.now - granted.at) },
			leaseId: lease.id,
			resourceKey: resourceKey(lease.resource),
			ownerKey: ownerKey(lease.owner),
			...(lease.label !== undefined ? { label: lease.label } : {}),
			...(lease.claimId !== undefined ? { claimId: lease.claimId } : {}),
		});
	}

	/** Append one lease event (join the caller's transaction when there is one). */
	recordEvent(event: NewLeaseEvent): void {
		insertLeaseEvent(this.db, event);
	}

	/** `queued` is logged once per claim call (its queue row is refreshed every round): false when already there. */
	recordQueuedOnce(event: Extract<NewLeaseEvent, { type: "queued" }>): boolean {
		return this.transaction(() => {
			const seen = this.db
				.query<{ n: number }, [string | null, string]>(
					"SELECT 1 AS n FROM lease_events WHERE type = 'queued' AND claim_id IS ?1 AND json_extract(data, '$.queueId') = ?2 LIMIT 1"
				)
				.get(event.claimId ?? null, event.data.queueId);
			if (seen) return false;
			this.recordEvent(event);
			return true;
		});
	}

	/**
	 * A holder's heartbeat found these leases gone: log `heartbeat_lost` for those no longer held, copying
	 * who/what from their `granted` event. Returns how many were logged.
	 */
	recordHeartbeatLost(ids: readonly string[], now: number): number {
		return this.transaction(() => {
			let logged = 0;
			for (const id of ids) {
				const event = this.getLease(id) ? undefined : this.heartbeatLostEvent(id, now);
				if (!event) continue;
				this.recordEvent(event);
				logged++;
			}
			return logged;
		});
	}

	/** The `heartbeat_lost` event of a granted lease (who/what copied from its grant); undefined for one never granted (ports, builds). */
	private heartbeatLostEvent(leaseId: string, at: number): NewLeaseEvent | undefined {
		const granted = this.db
			.query<GrantedRow, [string]>(
				"SELECT resource_key, owner_key, label, claim_id FROM lease_events WHERE lease_id = ? AND type = 'granted' LIMIT 1"
			)
			.get(leaseId);
		if (!granted) return undefined;
		return {
			at,
			type: "heartbeat_lost",
			data: {},
			leaseId,
			...(granted.resource_key ? { resourceKey: granted.resource_key } : {}),
			...(granted.owner_key ? { ownerKey: granted.owner_key } : {}),
			...(granted.label ? { label: granted.label } : {}),
			...(granted.claim_id ? { claimId: granted.claim_id } : {}),
		};
	}

	listEvents(filter: EventFilter = {}): LeaseEvent[] {
		return queryLeaseEvents(this.db, filter);
	}

	/** Delete events older than `before` (ms). */
	pruneEvents(before: number): number {
		return pruneLeaseEvents(this.db, before);
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
			this.deleteLeases(stale, { type: "expired", now });
			return stale;
		});
	}

	/** Insert a queue row; an existing id keeps its `enqueuedAt` (queue age) and updates the rest. */
	enqueue(entry: QueueEntry): QueueEntry {
		return this.transaction(() => {
			this.db
				.query(
					`INSERT INTO boot_queue (id, platform, profile, units, priority, enqueued_at, heartbeat_at, owner_key, owner, label, pid, reason, claim_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (id) DO UPDATE SET platform = excluded.platform, profile = excluded.profile, units = excluded.units,
					   heartbeat_at = excluded.heartbeat_at, label = excluded.label, pid = excluded.pid, reason = excluded.reason, claim_id = excluded.claim_id`
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
					entry.pid ?? null,
					entry.reason ?? null,
					entry.claimId ?? null
				);
			const row = this.db.query<QueueRow, [string]>("SELECT * FROM boot_queue WHERE id = ?").get(entry.id);
			if (!row) throw new Error(`boot_queue row ${entry.id} vanished`);
			return toQueueEntry(row);
		});
	}

	/** Stamp `heartbeat_at` and the live wait `reason`; false when the row is gone (reclaimed or dequeued). */
	refreshQueue(id: string, now: number, reason?: WaitReason): boolean {
		return (
			this.db
				.query("UPDATE boot_queue SET heartbeat_at = ?, reason = COALESCE(?, reason) WHERE id = ?")
				.run(now, reason ?? null, id).changes > 0
		);
	}

	/** The claim an owner's idempotency key points at (caller holds the transaction), if any. */
	getClaimKey(ownerKey: string, key: string): ClaimKey | undefined {
		const row = this.db
			.query<ClaimKeyRow, [string, string]>("SELECT * FROM claim_keys WHERE owner_key = ? AND key = ?")
			.get(ownerKey, key);
		if (!row) return undefined;
		return {
			ownerKey: row.owner_key,
			key: row.key,
			claimId: row.claim_id,
			platform: row.platform,
			profile: row.profile,
			count: row.count,
			ready: row.ready === 1,
		};
	}

	/** Point (owner, key) at a claim, replacing a stale mapping; `ready` stays false until the claim is granted. */
	setClaimKey(entry: Omit<ClaimKey, "ready">, now: number): void {
		this.db
			.query(
				"INSERT OR REPLACE INTO claim_keys (owner_key, key, claim_id, platform, profile, count, ready, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"
			)
			.run(entry.ownerKey, entry.key, entry.claimId, entry.platform, entry.profile, entry.count, now);
	}

	/** The claim's leases are all granted: a repeat of its key now returns them. */
	markClaimKeyReady(claimId: string): void {
		this.db.query("UPDATE claim_keys SET ready = 1 WHERE claim_id = ?").run(claimId);
	}

	deleteClaimKey(ownerKey: string, key: string): void {
		this.db.query("DELETE FROM claim_keys WHERE owner_key = ? AND key = ?").run(ownerKey, key);
	}

	/** Forget the keys of a claim that failed (its leases are gone). */
	deleteClaimKeysOf(claimId: string): void {
		this.db.query("DELETE FROM claim_keys WHERE claim_id = ?").run(claimId);
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
		device: Omit<
			DeviceRecord,
			"createdAt" | "lastUsedAt" | "quarantinedAt" | "quarantineReason" | "slimmedAt" | "persistentAt"
		>,
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
			this.recordEvent({
				at: now,
				type: "quarantined",
				data: {
					platform: device.platform,
					deviceId: device.id,
					deviceName: device.name,
					...(reason !== undefined ? { reason } : {}),
				},
				resourceKey: `device:${device.platform}:${device.id}`,
			});
		});
	}

	/** Clear quarantine on every recorded device with this id (any platform); returns how many were cleared. */
	unquarantineDevice(id: string, now: number): number {
		return this.transaction(() => {
			const cleared = this.db
				.query<{ platform: Platform }, [string]>(
					"SELECT platform FROM devices WHERE id = ? AND quarantined_at IS NOT NULL"
				)
				.all(id);
			this.db
				.query(
					"UPDATE devices SET quarantined_at = NULL, quarantine_reason = NULL WHERE id = ? AND quarantined_at IS NOT NULL"
				)
				.run(id);
			for (const { platform } of cleared) {
				this.recordEvent({
					at: now,
					type: "unquarantined",
					data: { platform, deviceId: id },
					resourceKey: `device:${platform}:${id}`,
				});
			}
			return cleared.length;
		});
	}

	/** Record (`at` set) or clear (`at` undefined) that a recorded device's daemons are slimmed. */
	setSlimmed(platform: Platform, id: string, at: number | undefined): void {
		this.db.query("UPDATE devices SET slimmed_at = ? WHERE platform = ? AND id = ?").run(at ?? null, platform, id);
	}

	/**
	 * Mark a recorded device persistent (never deleted as ephemeral). Update-only: a record is what makes a device
	 * warden-created (`shouldShutdown`), so a sim that was already running when leased must not gain one here.
	 */
	markPersistent(platform: Platform, id: string, now: number): void {
		this.db.query("UPDATE devices SET persistent_at = ? WHERE platform = ? AND id = ?").run(now, platform, id);
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
