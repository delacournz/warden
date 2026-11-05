import { PENDING_PREFIX } from "./claim";
import { DEFAULT_READY_TIMEOUT_MS } from "./config.defaults";
import { markWardenDevices } from "./inventory";
import type { PidAlive } from "./liveness";
import { instanceId, type MarkerFs, readMarker, simDeviceDir } from "./ownership";
import type { Store } from "./store";
import { type InventoryDevice, type Lease, type Platform, resourceKey } from "./types";

/**
 * `warden doctor --leases`: drift between the registry (leases, queue, device records, claim keys) and the
 * machine (the providers' inventory). `diagnoseLeases` only reads; `applyLeaseFixes` deletes registry rows
 * and never touches a device.
 */

export type LeaseFinding =
	/** a live device lease on a device the provider no longer lists */
	| { kind: "lease_missing_device"; leaseId: string; platform: Platform; deviceId: string; name: string }
	/** a booted warden-created device nobody leases and gc's idle pass cannot see (no `devices` record) */
	| { kind: "untracked_booted"; platform: Platform; deviceId: string; name: string }
	/** a `pending:` create placeholder older than the ready timeout whose holder is gone */
	| { kind: "stale_placeholder"; leaseId: string; name: string; ageMs: number }
	/** a boot-queue row whose waiter process is dead */
	| { kind: "dead_queue_row"; queueId: string; pid: number }
	/** a recorded iOS sim that is neither in the inventory nor on disk */
	| { kind: "device_missing"; platform: Platform; deviceId: string; name: string }
	/** the sim's ownership marker names another warden instance (`found` = its id, or `unreadable`) */
	| { kind: "marker_mismatch"; platform: Platform; deviceId: string; name: string; found: string }
	/** a recorded sim made before markers existed */
	| { kind: "marker_missing"; platform: Platform; deviceId: string; name: string }
	/** an idempotency key whose claim holds no lease and no queue row */
	| { kind: "stale_claim_key"; ownerKey: string; key: string; claimId: string }
	/** reclaim retry bookkeeping for a device that is no longer in a reclaim quarantine */
	| { kind: "orphan_reclaim_state"; platform: Platform; deviceId: string };

export type LeaseFindingKind = LeaseFinding["kind"];

/**
 * `drift` findings fail the run (exit 1 unless fixed); `info` ones are bookkeeping that cleans itself up
 * lazily (a key is dropped on its next use, an old sim has no marker) and never fail it.
 */
export function findingSeverity(f: LeaseFinding): "drift" | "info" {
	switch (f.kind) {
		case "marker_missing":
		case "stale_claim_key":
		case "orphan_reclaim_state":
			return "info";
		default:
			return "drift";
	}
}

/** Registry-safe: `--fix` can resolve it by deleting a row. The rest are reported only. */
export function findingFixable(f: LeaseFinding): boolean {
	switch (f.kind) {
		case "untracked_booted":
		case "marker_mismatch":
		case "marker_missing":
			return false;
		default:
			return true;
	}
}

export function describeFinding(f: LeaseFinding): string {
	switch (f.kind) {
		case "lease_missing_device":
			return `lease ${f.leaseId} holds ${f.name} (${f.deviceId}), which no longer exists`;
		case "untracked_booted":
			return `${f.name} (${f.deviceId}) is booted, unleased and has no device record: gc's idle pass will not shut it down`;
		case "stale_placeholder":
			return `create placeholder ${f.leaseId} (${f.name}) is ${Math.round(f.ageMs / 60_000)}m old and its holder is gone`;
		case "dead_queue_row":
			return `queue row ${f.queueId} waits on dead pid ${f.pid}`;
		case "device_missing":
			return `recorded device ${f.name} (${f.deviceId}) is gone from the machine`;
		case "marker_mismatch":
			return `${f.name} (${f.deviceId}) carries the ownership marker of another warden instance (${f.found})`;
		case "marker_missing":
			return `${f.name} (${f.deviceId}) has no ownership marker (made before markers existed)`;
		case "stale_claim_key":
			return `idempotency key "${f.key}" of ${f.ownerKey} points at claim ${f.claimId}, which holds nothing`;
		case "orphan_reclaim_state":
			return `reclaim retry state of ${f.platform}:${f.deviceId} outlived its quarantine`;
	}
}

export type LeaseDoctorInput = {
	store: Store;
	now: number;
	pidAlive: PidAlive;
	/** the provider inventory per platform; a platform that could not be read is left out and its checks skipped */
	inventories: Partial<Record<Platform, InventoryDevice[]>>;
	env: Record<string, string | undefined>;
	markerFs: MarkerFs;
	readyTimeoutMs?: number;
};

const isDeviceLease = (l: Lease): l is Lease & { resource: { kind: "device" } } => l.resource.kind === "device";

function leaseChecks(input: LeaseDoctorInput): LeaseFinding[] {
	const { store, now, pidAlive } = input;
	const readyMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const findings: LeaseFinding[] = [];
	for (const lease of store.listLeases().filter(isDeviceLease)) {
		const r = lease.resource;
		if (r.id.startsWith(PENDING_PREFIX)) {
			const age = now - lease.acquiredAt;
			const holderGone = lease.pid === undefined || !pidAlive(lease.pid) || now - lease.heartbeatAt > lease.ttlMs;
			if (age > readyMs && holderGone) {
				findings.push({ kind: "stale_placeholder", leaseId: lease.id, name: r.name, ageMs: age });
			}
			continue;
		}
		const inventory = input.inventories[r.platform];
		if (r.physical || inventory === undefined) continue;
		if (!inventory.some((d) => d.id === r.id)) {
			findings.push({
				kind: "lease_missing_device",
				leaseId: lease.id,
				platform: r.platform,
				deviceId: r.id,
				name: r.name,
			});
		}
	}
	return findings;
}

function queueChecks({ store, pidAlive }: LeaseDoctorInput): LeaseFinding[] {
	return store
		.listQueue()
		.flatMap((e): LeaseFinding[] =>
			e.pid !== undefined && !pidAlive(e.pid) ? [{ kind: "dead_queue_row", queueId: e.id, pid: e.pid }] : []
		);
}

function untrackedChecks(input: LeaseDoctorInput): LeaseFinding[] {
	const leased = new Set(input.store.listLeases().map((l) => resourceKey(l.resource)));
	const findings: LeaseFinding[] = [];
	for (const [platform, inventory] of Object.entries(input.inventories) as Array<[Platform, InventoryDevice[]]>) {
		const records = input.store.listDevices(platform);
		const recorded = new Set(records.map((r) => r.id));
		for (const d of markWardenDevices(inventory, records)) {
			if (!d.wardenCreated || d.golden || d.physical || d.state === "shutdown") continue;
			if (leased.has(`device:${d.platform}:${d.id}`) || recorded.has(d.id)) continue;
			findings.push({ kind: "untracked_booted", platform: d.platform, deviceId: d.id, name: d.name });
		}
	}
	return findings;
}

function iosDeviceChecks(input: LeaseDoctorInput): LeaseFinding[] {
	const inventory = input.inventories.ios;
	if (inventory === undefined) return [];
	const listed = new Set(inventory.map((d) => d.id));
	const mine = instanceId(input.store);
	const findings: LeaseFinding[] = [];
	for (const rec of input.store.listDevices("ios")) {
		const dir = simDeviceDir(input.env, rec.id);
		const onDisk = dir !== undefined && input.markerFs.isDir(dir);
		if (!listed.has(rec.id) && !onDisk) {
			findings.push({ kind: "device_missing", platform: "ios", deviceId: rec.id, name: rec.name });
			continue;
		}
		const base = { platform: "ios" as const, deviceId: rec.id, name: rec.name };
		const marker = readMarker(input.markerFs, input.env, rec.id);
		if (marker.kind === "absent") findings.push({ kind: "marker_missing", ...base });
		else if (marker.kind === "unreadable") findings.push({ kind: "marker_mismatch", ...base, found: "unreadable" });
		else if (marker.marker.instanceId !== mine) {
			findings.push({ kind: "marker_mismatch", ...base, found: marker.marker.instanceId });
		}
	}
	return findings;
}

type KeyRow = { owner_key: string; key: string; claim_id: string; created_at: number };

function claimKeyChecks({ store, now, readyTimeoutMs }: LeaseDoctorInput): LeaseFinding[] {
	const readyMs = readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const claims = new Set([
		...store.listLeases().flatMap((l) => (l.claimId === undefined ? [] : [l.claimId])),
		...store.listQueue().flatMap((q) => (q.claimId === undefined ? [] : [q.claimId])),
	]);
	return store.db
		.query<KeyRow, []>("SELECT owner_key, key, claim_id, created_at FROM claim_keys")
		.all()
		.filter((row) => !claims.has(row.claim_id) && now - row.created_at > readyMs)
		.map((row) => ({ kind: "stale_claim_key", ownerKey: row.owner_key, key: row.key, claimId: row.claim_id }));
}

const RECLAIM_META = /^reclaim:(ios|android):(.+)$/;

/** meta keys `reclaim:<platform>:<id>` of devices that are no longer reclaim-quarantined (or gone) */
function orphanReclaimKeys(store: Store): Array<{ key: string; platform: Platform; deviceId: string }> {
	const rows = store.db.query<{ key: string }, []>("SELECT key FROM meta WHERE key LIKE 'reclaim:%'").all();
	return rows.flatMap(({ key }) => {
		const m = RECLAIM_META.exec(key);
		if (m?.[1] === undefined || m[2] === undefined) return [];
		const platform: Platform = m[1] === "ios" ? "ios" : "android";
		const rec = store.listDevices(platform).find((d) => d.id === m[2]);
		return rec?.quarantinedAt !== undefined ? [] : [{ key, platform, deviceId: m[2] }];
	});
}

const reclaimChecks = ({ store }: LeaseDoctorInput): LeaseFinding[] =>
	orphanReclaimKeys(store).map((o) => ({ kind: "orphan_reclaim_state", platform: o.platform, deviceId: o.deviceId }));

/** Every drift finding, read-only. Order: leases, queue, untracked, devices/markers, claim keys, reclaim state. */
export function diagnoseLeases(input: LeaseDoctorInput): LeaseFinding[] {
	return [
		...leaseChecks(input),
		...queueChecks(input),
		...untrackedChecks(input),
		...iosDeviceChecks(input),
		...claimKeyChecks(input),
		...reclaimChecks(input),
	];
}

export type FixOutcome = { fixed: LeaseFinding[]; unfixed: LeaseFinding[] };

/**
 * Resolve the registry-safe findings by deleting rows, in one store transaction, re-checking each row first (the
 * world moved since the diagnosis). Never calls a provider: no device is shut down, erased or deleted, and a
 * device with a lease on it keeps its record. A deleted device lease logs `expired` when it was ever granted.
 */
export function applyLeaseFixes(
	store: Store,
	findings: readonly LeaseFinding[],
	now: number,
	pidAlive: PidAlive
): FixOutcome {
	const outcome: FixOutcome = { fixed: [], unfixed: [] };
	store.transaction(() => {
		for (const f of findings) {
			if (findingFixable(f) && fixOne(store, f, now, pidAlive)) outcome.fixed.push(f);
			else outcome.unfixed.push(f);
		}
	});
	return outcome;
}

type Finding<K extends LeaseFinding["kind"]> = Extract<LeaseFinding, { kind: K }>;

/** Delete a lease whose device is gone (logging `expired`) or a stale placeholder; false when it no longer matches. */
function fixLeaseRow(
	store: Store,
	f: Finding<"lease_missing_device"> | Finding<"stale_placeholder">,
	now: number
): boolean {
	const lease = store.getLease(f.leaseId);
	if (lease === undefined || lease.resource.kind !== "device") return false;
	if (f.kind === "stale_placeholder" && !lease.resource.id.startsWith(PENDING_PREFIX)) return false;
	if (f.kind === "lease_missing_device" && lease.resource.id !== f.deviceId) return false;
	return store.deleteLeases([f.leaseId], f.kind === "lease_missing_device" ? { type: "expired", now } : undefined) > 0;
}

/** Drop a queue row whose waiter is dead. */
function fixDeadQueueRow(store: Store, f: Finding<"dead_queue_row">, pidAlive: PidAlive): boolean {
	const row = store.listQueue().find((e) => e.id === f.queueId);
	return row?.pid !== undefined && !pidAlive(row.pid) && store.dequeue(f.queueId);
}

/** Forget a device record nothing holds a lease on. */
function fixDeviceMissing(store: Store, f: Finding<"device_missing">): boolean {
	const held = store.listLeases().some((l) => resourceKey(l.resource) === `device:${f.platform}:${f.deviceId}`);
	if (held) return false;
	store.forgetDevice(f.platform, f.deviceId);
	return true;
}

/** Delete an idempotency key whose claim has no lease and no queue row left. */
function fixStaleClaimKey(store: Store, f: Finding<"stale_claim_key">): boolean {
	const live =
		store.listLeases().some((l) => l.claimId === f.claimId) || store.listQueue().some((q) => q.claimId === f.claimId);
	if (live) return false;
	store.deleteClaimKey(f.ownerKey, f.key);
	return true;
}

/** Delete reclaim state kept for a device that no longer exists. */
function fixOrphanReclaim(store: Store, f: Finding<"orphan_reclaim_state">): boolean {
	const orphan = orphanReclaimKeys(store).find((o) => o.platform === f.platform && o.deviceId === f.deviceId);
	if (orphan === undefined) return false;
	store.deleteMeta(orphan.key);
	return true;
}

function fixOne(store: Store, f: LeaseFinding, now: number, pidAlive: PidAlive): boolean {
	switch (f.kind) {
		case "lease_missing_device":
		case "stale_placeholder":
			return fixLeaseRow(store, f, now);
		case "dead_queue_row":
			return fixDeadQueueRow(store, f, pidAlive);
		case "device_missing":
			return fixDeviceMissing(store, f);
		case "stale_claim_key":
			return fixStaleClaimKey(store, f);
		case "orphan_reclaim_state":
			return fixOrphanReclaim(store, f);
		case "untracked_booted":
		case "marker_mismatch":
		case "marker_missing":
			return false;
	}
}
