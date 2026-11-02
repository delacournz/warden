import type { Database } from "bun:sqlite";
import type { Result } from "@delacour/warden-types/result";
import type { WaitReason } from "./queue";
import type { Platform } from "./types";

/**
 * The lease event log: an append-only `lease_events` table, one row per thing that happened to a device
 * lease or device. Event type names are `snake_case` throughout (`heartbeat_lost`, `device_unhealthy`).
 * Rows are written inside the same store transaction as the change they record (see `Store`), pruned by
 * `warden gc` after `WARDEN_EVENTS_DAYS` (default 7).
 */

/** How a granted lease came to be: `leased` is a caller-side lease on a named device (`warden ui`). */
export type GrantAction = "reuse" | "boot" | "create" | "leased";

/** Per-type payloads (the JSON `data` column). */
export type LeaseEventPayloads = {
	/** a `claimDevices` call started */
	requested: { platform: Platform; profile: string; count: number };
	/** a claim started waiting (boot queue or polling for a device): once per claim call, with why */
	queued: { platform: Platform; profile: string; queueId: string; reason?: WaitReason };
	/** a device lease was handed to the caller; `waitMs` = time since the claim was requested */
	granted: {
		platform: Platform;
		profile?: string;
		deviceId: string;
		deviceName: string;
		action: GrantAction;
		waitMs: number;
	};
	/** a holder's heartbeat found its lease gone (released or reclaimed by someone else) */
	heartbeat_lost: Record<string, never>;
	/** the lease was deleted by its owner / a release; `heldMs` = time since it was granted */
	released: { heldMs: number };
	/** the lease went stale (owner process gone, heartbeat expired) and was reclaimed */
	expired: { heldMs: number };
	/** an idle warden device was shut down to make room for the queue head */
	evicted: { platform: Platform; deviceId: string; deviceName: string };
	quarantined: { platform: Platform; deviceId: string; deviceName: string; reason?: string };
	unquarantined: { platform: Platform; deviceId: string };
	/** warden shut a device down: `idle` (gc idle pass) or `release` (a lease ended with the device) */
	shutdown: { platform: Platform; deviceId: string; deviceName?: string; cause: "idle" | "release" };
	/** reserved: written by the health monitor under a lease */
	device_unhealthy: { platform: Platform; deviceId: string; reason?: string };
	device_recovered: { platform: Platform; deviceId: string };
};

export type LeaseEventType = keyof LeaseEventPayloads;

export const LEASE_EVENT_TYPES: readonly LeaseEventType[] = [
	"requested",
	"queued",
	"granted",
	"heartbeat_lost",
	"released",
	"expired",
	"evicted",
	"quarantined",
	"unquarantined",
	"shutdown",
	"device_unhealthy",
	"device_recovered",
];

type EventBase = {
	at: number;
	leaseId?: string;
	resourceKey?: string;
	ownerKey?: string;
	label?: string;
	claimId?: string;
};

/** An event to write; `data` is typed by `type`. */
export type NewLeaseEvent = {
	[T in LeaseEventType]: EventBase & { type: T; data: LeaseEventPayloads[T] };
}[LeaseEventType];

/** A stored event. */
export type LeaseEvent = NewLeaseEvent & { id: number };

type EventRow = {
	id: number;
	at: number;
	type: string;
	lease_id: string | null;
	resource_key: string | null;
	owner_key: string | null;
	label: string | null;
	claim_id: string | null;
	data: string;
};

export function insertLeaseEvent(db: Database, event: NewLeaseEvent): void {
	db.query(
		`INSERT INTO lease_events (at, type, lease_id, resource_key, owner_key, label, claim_id, data)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		event.at,
		event.type,
		event.leaseId ?? null,
		event.resourceKey ?? null,
		event.ownerKey ?? null,
		event.label ?? null,
		event.claimId ?? null,
		JSON.stringify(event.data)
	);
}

function isEventType(value: string): value is LeaseEventType {
	return (LEASE_EVENT_TYPES as readonly string[]).includes(value);
}

function toEvent(row: EventRow): LeaseEvent | undefined {
	if (!isEventType(row.type)) return undefined;
	const base = {
		id: row.id,
		at: row.at,
		type: row.type,
		data: JSON.parse(row.data) as Record<string, unknown>,
		...(row.lease_id !== null ? { leaseId: row.lease_id } : {}),
		...(row.resource_key !== null ? { resourceKey: row.resource_key } : {}),
		...(row.owner_key !== null ? { ownerKey: row.owner_key } : {}),
		...(row.label !== null ? { label: row.label } : {}),
		...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
	};
	// the row was written through `insertLeaseEvent`, so `data` matches `type`
	return base as unknown as LeaseEvent;
}

export type EventFilter = {
	/** only events at or after this time (ms) */
	since?: number;
	/** exact lease id */
	leaseId?: string;
	/** the owner key (`agent:<sessionId>`, `user:<pid>`, `ci:<runId>`) or any substring of it */
	owner?: string;
	/** only events with an id above this (the `--follow` cursor) */
	afterId?: number;
};

/** Events oldest first (by id), matching every given filter. */
export function queryLeaseEvents(db: Database, filter: EventFilter = {}): LeaseEvent[] {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (filter.since !== undefined) {
		where.push("at >= ?");
		params.push(filter.since);
	}
	if (filter.leaseId !== undefined) {
		where.push("lease_id = ?");
		params.push(filter.leaseId);
	}
	if (filter.owner !== undefined) {
		where.push("instr(owner_key, ?) > 0");
		params.push(filter.owner);
	}
	if (filter.afterId !== undefined) {
		where.push("id > ?");
		params.push(filter.afterId);
	}
	const sql = `SELECT * FROM lease_events${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
	return db
		.query<EventRow, (string | number)[]>(sql)
		.all(...params)
		.flatMap((row) => toEvent(row) ?? []);
}

/** Delete events older than `before` (ms); returns how many. */
export function pruneLeaseEvents(db: Database, before: number): number {
	return db.query("DELETE FROM lease_events WHERE at < ?").run(before).changes;
}

export const DEFAULT_EVENTS_DAYS = 7;
const DAY_MS = 86_400_000;

/** How long events are kept: `WARDEN_EVENTS_DAYS` (a positive integer) else 7 days. */
export function eventsRetentionMs(env: Record<string, string | undefined>): Result<number> {
	const raw = env.WARDEN_EVENTS_DAYS;
	if (raw === undefined || raw.trim() === "") return { success: true, data: DEFAULT_EVENTS_DAYS * DAY_MS };
	if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
		return { success: false, error: `WARDEN_EVENTS_DAYS must be a positive integer (got "${raw}")` };
	}
	return { success: true, data: Number(raw) * DAY_MS };
}

/** Labels of leases warden holds for its own housekeeping: never user-visible grants. */
export const INTERNAL_LEASE_LABELS: readonly string[] = ["capacity-evict", "gc-shutdown", "reclaiming"];
