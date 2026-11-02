import { randomUUID } from "node:crypto";
import { availableParallelism, loadavg } from "node:os";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { allocate } from "./allocate";
import {
	addCost,
	type Budget,
	type CapacityConfig,
	type Cost,
	capacityBlock,
	deviceCost,
	explain,
	fits,
	hostUsage,
	totalCost,
} from "./capacity";
import { type ClaimErrorKind, claimError, isRuntimeMissing } from "./claim-errors";
import type { OrphanHost } from "./conditions/orphans";
import { DEFAULT_READY_TIMEOUT_MS } from "./config.defaults";
import { formatDuration } from "./duration";
import type { MemoryPressure } from "./host";
import { markWardenDevices } from "./inventory";
import type { NewLeaseEvent } from "./lease-events";
import { isLeaseAlive, type PidAlive } from "./liveness";
import { countOtherClaims } from "./owner-limit";
import { isProbeTimeout } from "./providers/health";
import type { DeviceProvider } from "./providers/provider.types";
import { admissionQueue, type DeviceWaitReason, PRIORITY, priorityName, queuePosition, type WaitReason } from "./queue";
import { type DeviceRecord, ownerKey, type Store } from "./store";
import {
	type AllocationStep,
	type DeviceRequest,
	type DeviceResource,
	deviceResourceOf,
	type InventoryDevice,
	type Lease,
	type Owner,
	type Platform,
	physicalNotReadyReason,
	resourceKey,
} from "./types";
import { readWarmSet } from "./warm-pool";

/**
 * Device id prefix of a placeholder lease taken while a new device is being created outside the
 * transaction. It reserves the `warden-<profile>-N` name + a pool slot so a concurrent claimer can
 * neither pick the same name nor grab the fresh device before its creator leases it.
 */
export const PENDING_PREFIX = "pending:";

export type ClaimInput = {
	store: Store;
	provider: DeviceProvider;
	owner: Owner;
	request: DeviceRequest;
	ttlMs: number;
	label?: string;
	/** pid recorded on the device leases (lease survives while it is alive) */
	pid?: number;
	now: () => number;
	pidAlive: PidAlive;
	/** how long to keep polling when every matching device is leased; 0 = fail immediately */
	waitMs: number;
	pollMs?: number;
	sleep?: (ms: number) => Promise<void>;
	readyTimeoutMs?: number;
	/** pid of this claiming process — keeps create placeholders alive while it runs (default `process.pid`) */
	selfPid?: number;
	/** progress notes (health-probe quarantines) — stderr in the CLI */
	log?: (line: string) => void;
	/** 1-min load average and core count, read when a probe times out (default: `os.loadavg` / `os.availableParallelism`) */
	load?: () => HostLoad;
	/** machine capacity gate + priority boot queue; absent = no gate (claims never queue) */
	capacity?: CapacityDeps;
	/** queue priority, higher first (default `PRIORITY.normal`) */
	priority?: number;
	/** queue row id (default: a fresh id per `claimDevices` call) */
	queueId?: string;
	/** new iOS sims count as slim for capacity (default true); `--no-slim` / `slim: false` sets false */
	slim?: boolean;
	/** most separate claims this owner may hold on the platform (live device leases + its other queued claims); absent = unlimited */
	ownerLimit?: number;
	/** groups the leases of one command's claims (a wrapper's legs share it); default: one per `claimDevices` call */
	claimId?: string;
	/** when the claim was requested (ms); `claimDevices` sets it, `granted` events measure their wait from it */
	requestedAt?: number;
	/**
	 * Makes the claim repeatable: while this owner's earlier claim under the same key still holds its
	 * leases, the claim returns them (action `reuse`) instead of taking devices, logs no events and
	 * queues nothing. A different request under the key is an error; an earlier claim still booting is waited for.
	 */
	idempotencyKey?: string;
	/** polled once per round: true ends the claim with `CLAIM_ABORTED` (nothing stays leased or queued) */
	abort?: () => boolean;
	/** conditions a deleted lease left on a claimed device are undone before the claim returns; absent = left for gc */
	orphans?: OrphanHost;
};

/** The error of a claim ended by `ClaimInput.abort`. */
export const CLAIM_ABORTED = "claim aborted";

export type CapacityDeps = {
	budget: Budget;
	config: CapacityConfig;
	/** every device on the host, all platforms, foreign included */
	hostInventory: () => AsyncResult<InventoryDevice[]>;
	/** read once per round; an error counts as `normal` */
	pressure?: () => AsyncResult<MemoryPressure>;
	/** shut down an idle warden device (any platform) to make room for the queue head; absent = never evict */
	shutdownIdle?: (device: InventoryDevice) => AsyncResult<void>;
};

/** Per-round capacity facts, read outside the store lock. */
type CapacityRound = {
	deps: CapacityDeps;
	hostInventory: InventoryDevice[];
	pressure: MemoryPressure;
	queueId: string;
	/** when this `claimDevices` call began: queue age and place survive health-probe retry rounds */
	enqueuedAt: number;
	/** devices whose idle shutdown failed this claim: not tried again */
	noEvict: ReadonlySet<string>;
};

type Eviction = { device: InventoryDevice; leaseId: string };

export type HostLoad = { load1: number; cores: number };

/**
 * Quarantines this claim sets carry this reason prefix, and expire after `QUARANTINE_TTL_MS` (16-10):
 * a sim quarantined on a bad day gets one more chance. A quarantine a person set (`release --bad`)
 * has no prefix and stays until `warden sim unquarantine`.
 */
export const CLAIM_QUARANTINE_PREFIX = "claim: ";
export const QUARANTINE_TTL_MS = 24 * 60 * 60_000;
/** Wait before the one re-probe of a sim that timed out on an overloaded host. */
export const OVERLOAD_REPROBE_MS = 5_000;

const hostLoad = (): HostLoad => ({ load1: loadavg()[0] ?? 0, cores: availableParallelism() });

export type ClaimedDevice = { lease: Lease; device: InventoryDevice; action: AllocationStep["action"] };

export type ClaimOutcome = { claimed: ClaimedDevice[]; reclaimed: string[] };

type Reserved =
	| { action: "reuse" | "boot"; device: InventoryDevice; lease: Lease }
	| { action: "create"; name: string; lease: Lease };

type Reservation =
	| { kind: "assign"; items: Reserved[] }
	| { kind: "limited"; message: string }
	| { kind: "existing"; claimed: ClaimedDevice[] }
	| { kind: "key-busy" }
	| { kind: "key-mismatch"; message: string }
	| { kind: "wait"; poolSize: number; notReady: string[]; blocked: DeviceWaitReason }
	| { kind: "queued"; position: number; total: number; reason: string; blocked: QueueBlocked; evict: Eviction[] };

/** What holds a queued claim: rows ahead of it, or (at the head) a resource the host is out of. */
type QueueBlocked = Exclude<WaitReason, DeviceWaitReason>;

const DEFAULT_POLL_MS = 2_000;
const MAX_CONFLICT_RETRIES = 5;
/** Re-claims after a device fails its health probe (so up to 3 attempts in all). */
const MAX_HEALTH_RETRIES = 2;

/** Resource of a pending (being created) device: a placeholder, never physical. */
function placeholderResource(device: { platform: Platform; id: string; name: string }): DeviceResource {
	return { kind: "device", platform: device.platform, id: device.id, name: device.name };
}

function isPendingLease(lease: Lease, platform: Platform): lease is Lease & { resource: DeviceResource } {
	return (
		lease.resource.kind === "device" &&
		lease.resource.platform === platform &&
		lease.resource.id.startsWith(PENDING_PREFIX)
	);
}

/**
 * Replace devices being created (placeholder leases) with synthetic `booting` entries: the name and
 * pool slot are taken, and a just-created sim that isn't leased yet is hidden from other claimers.
 */
export function withPendingDevices(
	inventory: InventoryDevice[],
	leases: Lease[],
	platform: Platform
): InventoryDevice[] {
	const pending = leases.filter((l) => isPendingLease(l, platform)).map((l) => l.resource);
	if (pending.length === 0) return inventory;
	const names = new Set(pending.map((r) => r.name));
	return [
		...inventory.filter((d) => !(d.platform === platform && names.has(d.name))),
		...pending.map(
			(r): InventoryDevice => ({ platform, id: r.id, name: r.name, state: "booting", wardenCreated: false })
		),
	];
}

function isUniqueConflict(error: unknown): boolean {
	return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function reserve(
	input: ClaimInput,
	rawInventory: InventoryDevice[],
	reclaimed: string[],
	skip: ReadonlySet<string>,
	cap?: CapacityRound
): Reservation {
	const { store, request, owner } = input;
	const now = input.now();
	reclaimed.push(...store.reclaimStale(now, input.pidAlive));
	const leases = store.listLeases();
	const withPending = withPendingDevices(rawInventory, leases, request.platform);
	const inventory = markWardenDevices(
		withPending,
		liftExpiredQuarantines(input, withPending, store.listDevices(request.platform), now)
	);
	const keyed = idempotentReservation(input, leases, rawInventory, now);
	if (keyed) return keyed;
	if (cap || input.ownerLimit !== undefined) store.reclaimStaleQueue(now, input.pidAlive);
	const limited = ownerLimitHit(input, leases, cap, now);
	if (limited) return limited;
	const plan = allocate({ inventory, leases, request, now, pidAlive: input.pidAlive, skip });
	if (cap && plan.kind === "assign") {
		const gate = admit(input, cap, plan.steps, leases, now);
		if (gate) return gate;
	}
	if (plan.kind === "wait") {
		const blocked: DeviceWaitReason = request.physical ? "waiting-for-device" : "device-limit";
		if (cap) holdWaitRow(input, cap, blocked, now);
		const poolSize = inventory.filter(
			(d) => d.platform === request.platform && d.wardenCreated && d.profile === request.profile
		).length;
		return { kind: "wait", poolSize, notReady: notReadyPhysical(inventory, request), blocked };
	}
	if (cap) store.dequeue(cap.queueId);
	const common = { owner, ...(input.label !== undefined ? { label: input.label } : {}), ...claimField(input) };
	const items = plan.steps.map((step): Reserved => {
		if (step.action === "create") {
			const placeholder = { platform: request.platform, id: `${PENDING_PREFIX}${step.name}`, name: step.name };
			const lease = store.insertLease(
				{
					resource: placeholderResource(placeholder),
					...common,
					ttlMs: Math.min(input.ttlMs, input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
					pid: input.selfPid ?? process.pid,
				},
				now
			);
			return { action: "create", name: step.name, lease };
		}
		const lease = store.insertLease(
			{
				resource: deviceResourceOf(step.device),
				...common,
				ttlMs: input.ttlMs,
				...(input.pid !== undefined ? { pid: input.pid } : {}),
			},
			now
		);
		return { action: step.action, device: step.device, lease };
	});
	if (input.idempotencyKey !== undefined && input.claimId !== undefined) {
		store.setClaimKey(
			{
				ownerKey: ownerKey(owner),
				key: input.idempotencyKey,
				claimId: input.claimId,
				platform: request.platform,
				profile: request.profile,
				count: request.count,
			},
			now
		);
	}
	return { kind: "assign", items };
}

/**
 * The idempotency key check (caller holds the store lock): undefined to claim as usual, else the
 * earlier claim's leases (`existing`), a wait for it to finish (`key-busy`) or a refusal (`key-mismatch`).
 * A mapping whose leases are gone (released, expired, failed claim) is stale and replaced by this claim.
 */
function idempotentReservation(
	input: ClaimInput,
	leases: Lease[],
	inventory: InventoryDevice[],
	now: number
): Reservation | undefined {
	const key = input.idempotencyKey;
	if (key === undefined) return undefined;
	const { store, request } = input;
	const okey = ownerKey(input.owner);
	const row = store.getClaimKey(okey, key);
	if (!row || row.claimId === input.claimId) return undefined;
	const held = leases.filter((l) => l.claimId === row.claimId && ownerKey(l.owner) === okey);
	if (held.length < row.count) {
		store.deleteClaimKey(okey, key);
		return undefined;
	}
	if (row.platform !== request.platform || row.profile !== request.profile || row.count !== request.count) {
		const was = `${row.platform} ${row.profile} x${row.count}`;
		return {
			kind: "key-mismatch",
			message: `idempotency key ${key} was used for a different request (${was}); use another key or release its leases first`,
		};
	}
	if (!row.ready) return { kind: "key-busy" };
	store.heartbeat(
		held.map((l) => l.id),
		now
	);
	const claimed = held.map((lease): ClaimedDevice => {
		const res = lease.resource;
		const device =
			res.kind === "device"
				? (inventory.find((d) => d.platform === res.platform && d.id === res.id) ?? {
						platform: res.platform,
						id: res.id,
						name: res.name,
						state: "booted" as const,
						wardenCreated: false,
					})
				: undefined;
		return { lease: { ...lease, heartbeatAt: now }, device: device as InventoryDevice, action: "reuse" };
	});
	return { kind: "existing", claimed };
}

const claimField = (input: ClaimInput): { claimId?: string } =>
	input.claimId !== undefined ? { claimId: input.claimId } : {};

/**
 * The per-owner limit (caller holds the store lock): undefined to go on, else the `limited` reservation.
 * It counts the owner's other claims on the platform, so a wrapper's legs (one claim id) never block each other.
 */
function ownerLimitHit(
	input: ClaimInput,
	leases: Lease[],
	cap: CapacityRound | undefined,
	now: number
): Extract<Reservation, { kind: "limited" }> | undefined {
	const limit = input.ownerLimit;
	if (limit === undefined) return undefined;
	const { platform } = input.request;
	const others = countOtherClaims({
		leases,
		queue: input.store.listQueue(),
		owner: input.owner,
		platform,
		claimId: input.claimId ?? "",
		queueId: cap?.queueId ?? "",
	});
	if (others.count < limit) return undefined;
	if (cap) holdWaitRow(input, cap, "requester-limit", now);
	const holding = `this owner already holds ${others.count} separate ${platform} claim(s) (limit ${limit}, WARDEN_MAX_PER_OWNER)`;
	const fix = others.oldest
		? `release the oldest, ${others.oldest.id}${others.oldest.label ? ` (${others.oldest.label})` : ""}, with: warden release ${others.oldest.id}`
		: "wait for its queued claims to finish";
	return { kind: "limited", message: `${holding}: ${fix}` };
}

/**
 * A claim polling for a device keeps a queue row carrying why (`warden queue` shows it). It needs no boot
 * slot, so `admissionQueue` leaves it out of positions and heads: it never delays a claim that does.
 */
function holdWaitRow(input: ClaimInput, cap: CapacityRound, reason: DeviceWaitReason, now: number): void {
	noteQueued(input, cap, reason, now);
	input.store.enqueue({
		id: cap.queueId,
		platform: input.request.platform,
		profile: input.request.profile,
		units: 0,
		priority: input.priority ?? PRIORITY.normal,
		enqueuedAt: cap.enqueuedAt,
		heartbeatAt: now,
		owner: input.owner,
		...(input.label !== undefined ? { label: input.label } : {}),
		pid: input.selfPid ?? process.pid,
		reason,
		...claimField(input),
	});
}

/** Log that this claim started waiting (once per claim call, with the first reason). */
function noteQueued(input: ClaimInput, cap: CapacityRound, reason: WaitReason, now: number): void {
	input.store.recordQueuedOnce({
		at: now,
		type: "queued",
		data: { platform: input.request.platform, profile: input.request.profile, queueId: cap.queueId, reason },
		ownerKey: ownerKey(input.owner),
		...claimField(input),
		...(input.label !== undefined ? { label: input.label } : {}),
	});
}

const bootedState = (d: InventoryDevice): boolean => d.state === "booted" || d.state === "booting";

/** Usage as the planner sees it: the host inventory plus creates still pending in this lease table. */
function claimUsage(cap: CapacityRound, leases: Lease[], slimmed: ReadonlySet<string>, slimCreates: boolean): Cost {
	const names = new Set(cap.hostInventory.filter((d) => bootedState(d) && d.physical === undefined).map((d) => d.name));
	const pending = leases.flatMap((l) =>
		l.resource.kind === "device" && l.resource.id.startsWith(PENDING_PREFIX) && !names.has(l.resource.name)
			? [l.resource.platform]
			: []
	);
	// a create still pending counts slim unless the claim opted out (slim is default-on for new iOS sims)
	return hostUsage(cap.hostInventory, cap.deps.config, slimmed, { platforms: pending, slim: slimCreates });
}

/** Ids of iOS devices whose store record says `sim slim` ran. */
function slimmedIds(store: Store): Set<string> {
	return new Set(
		store
			.listDevices("ios")
			.filter((r) => r.slimmedAt !== undefined)
			.map((r) => r.id)
	);
}

/**
 * The capacity gate (caller holds the store lock): undefined to proceed, else the `queued` reservation.
 * A plan that only reuses booted devices needs no slot and always proceeds (backfill). Otherwise the
 * claim must be queue head, fit the budget and see no memory pressure.
 */
function admit(
	input: ClaimInput,
	cap: CapacityRound,
	steps: AllocationStep[],
	leases: Lease[],
	now: number
): Extract<Reservation, { kind: "queued" }> | undefined {
	const { store, request } = input;
	const boots = steps.filter((s) => s.action !== "reuse").length;
	if (boots === 0) {
		store.dequeue(cap.queueId);
		return undefined;
	}
	const { config, budget } = cap.deps;
	const slimmed = slimmedIds(store);
	// a create is slim under the default-on policy unless opted out; a boot of an existing device is slim when its record says so.
	const slimCreates = input.slim !== false;
	const bootSteps = steps.filter((s) => s.action !== "reuse");
	const need = totalCost(
		Array<Platform>(boots).fill(request.platform),
		config,
		bootSteps.map((s) =>
			request.platform === "ios" ? (s.action === "create" ? slimCreates : slimmed.has(s.device.id)) : false
		)
	);
	store.enqueue({
		id: cap.queueId,
		platform: request.platform,
		profile: request.profile,
		units: need.cpu,
		priority: input.priority ?? PRIORITY.normal,
		enqueuedAt: cap.enqueuedAt,
		heartbeatAt: now,
		owner: input.owner,
		...(input.label !== undefined ? { label: input.label } : {}),
		pid: input.selfPid ?? process.pid,
		...claimField(input),
	});
	const entries = admissionQueue(store.listQueue());
	const position = queuePosition(entries, cap.queueId, now) ?? 1;
	const head = position === 1;
	const usage = claimUsage(cap, leases, slimmed, slimCreates);
	const fit = fits(usage, need, budget);
	const held = cap.pressure !== "normal";
	if (head && fit.fits && !held) return undefined;
	const blocked: QueueBlocked = capacityBlock(fit, held) ?? "behind-earlier";
	store.refreshQueue(cap.queueId, now, blocked);
	noteQueued(input, cap, blocked, now);
	const reason = !fit.fits
		? explain(fit, usage, budget)
		: held
			? `memory pressure ${cap.pressure}`
			: "waiting behind higher-priority claims";
	const evict = head && !fit.fits ? pickEvictions(input, cap, steps, leases, usage, need, now) : [];
	return { kind: "queued", position, total: entries.length, reason, blocked, evict };
}

/** The coded error of a claim whose `--wait` ran out in the boot queue. */
function queueTimeout(reservation: Extract<Reservation, { kind: "queued" }>): string {
	const { position, total, reason, blocked } = reservation;
	const kind: ClaimErrorKind =
		blocked === "behind-earlier" ? { code: "QUEUE_TIMEOUT" } : { code: "NO_CAPACITY", capacityReason: blocked };
	return claimError(kind, `timed out in the boot queue at #${position} of ${total}: ${reason}`);
}

/**
 * Idle warden devices to shut down so the queue head fits: booted, no live lease, not golden or
 * quarantined, not about to be reused by this plan; least recently used first. Empty unless shutting
 * them all down actually makes room. Each gets a lease so nobody claims it before it is shut down.
 */
function pickEvictions(
	input: ClaimInput,
	cap: CapacityRound,
	steps: AllocationStep[],
	leases: Lease[],
	usage: Cost,
	need: Cost,
	now: number
): Eviction[] {
	const { store } = input;
	if (!cap.deps.shutdownIdle) return [];
	const held = new Set(leases.filter((l) => isLeaseAlive(l, now, input.pidAlive)).map((l) => resourceKey(l.resource)));
	const planned = new Set(steps.flatMap((s) => (s.action === "create" ? [] : [s.device.id])));
	const records = store.listDevices();
	const slimmed = slimmedIds(store);
	const lastUsed = new Map(records.map((r) => [`${r.platform}:${r.id}`, r.lastUsedAt]));
	const used = (d: InventoryDevice) => lastUsed.get(`${d.platform}:${d.id}`) ?? 0;
	const warm = readWarmSet(store, now);
	const inWarmSet = (d: InventoryDevice) => warm.has(`${d.platform}:${d.id}`);
	const idle = markWardenDevices(cap.hostInventory, records)
		.filter(
			(d) =>
				d.state === "booted" &&
				d.physical === undefined &&
				d.wardenCreated &&
				d.golden !== true &&
				d.quarantined !== true &&
				!planned.has(d.id) &&
				!cap.noEvict.has(d.id) &&
				!held.has(resourceKey(deviceResourceOf(d)))
		)
		.sort((a, b) => Number(inWarmSet(a)) - Number(inWarmSet(b)) || used(a) - used(b));
	const picked: InventoryDevice[] = [];
	let left = usage;
	for (const device of idle) {
		const cost = deviceCost(device.platform, cap.deps.config, { slim: slimmed.has(device.id) });
		left = addCost(left, { memMb: -cost.memMb, cpu: -cost.cpu });
		picked.push(device);
		if (fits(left, need, cap.deps.budget).fits) {
			return picked.map((device) => ({
				device,
				leaseId: store.insertLease(
					{
						resource: deviceResourceOf(device),
						owner: input.owner,
						label: "capacity-evict",
						...claimField(input),
						ttlMs: input.ttlMs,
						pid: input.selfPid ?? process.pid,
					},
					now
				).id,
			}));
		}
	}
	return [];
}

function claimQuarantineExpired(record: DeviceRecord, now: number): boolean {
	return (
		record.quarantinedAt !== undefined &&
		record.quarantineReason?.startsWith(CLAIM_QUARANTINE_PREFIX) === true &&
		now - record.quarantinedAt >= QUARANTINE_TTL_MS
	);
}

/**
 * Clear claim quarantines older than `QUARANTINE_TTL_MS` on pool devices of the requested profile
 * (caller holds the store lock); the records as they now are. Only as many as the pool has room for
 * under `max`: a quarantined device's slot went to a replacement, so lifting every expired one would
 * grow the pool past `max`. The rest stay quarantined until a slot frees up.
 */
function liftExpiredQuarantines(
	input: ClaimInput,
	inventory: InventoryDevice[],
	records: DeviceRecord[],
	now: number
): DeviceRecord[] {
	const { request } = input;
	const pool = markWardenDevices(inventory, records).filter(
		(d) => d.platform === request.platform && d.wardenCreated && d.golden !== true && d.profile === request.profile
	);
	const inPool = new Set(pool.map((d) => d.id));
	let room = request.max - pool.filter((d) => d.quarantined !== true).length;
	return records.map((record) => {
		if (!inPool.has(record.id) || !claimQuarantineExpired(record, now) || room <= 0) return record;
		room--;
		input.store.unquarantineDevice(record.id, now);
		input.log?.(`${record.name} (${record.id}): quarantine expired after 24h — offering it again`);
		const { quarantinedAt: _at, quarantineReason: _reason, ...lifted } = record;
		return lifted;
	});
}

type Realised = {
	ok: Result<ClaimedDevice>;
	leaseId: string;
	/** the device booted but never got ready, or failed its health probe */
	unhealthy?: UnhealthyDevice;
};

/**
 * A device that failed this claim. `skipOnly`: its probe timed out twice on an overloaded host — a
 * busy host, not a hung sim — so it is left out of this claim but not quarantined or shut down.
 */
type UnhealthyDevice = {
	device: InventoryDevice;
	reason: string;
	skipOnly?: true;
	/** the load reading behind `skipOnly` */
	load?: HostLoad;
	/** `skipOnly` on a device this claim booted: shut it down again rather than leave it booted unleased */
	bootedByClaim?: true;
};

/** The load reading when the host is overloaded (1-min load ≥ cores), else undefined. */
function overload(input: ClaimInput): HostLoad | undefined {
	const load = (input.load ?? hostLoad)();
	return load.load1 >= load.cores ? load : undefined;
}

/**
 * The health probe, with one more chance under load (16-10): a timeout while the 1-min load average is
 * at or above the core count is asked again after `OVERLOAD_REPROBE_MS`; a second timeout skips the
 * device this round instead of quarantining it. Any other failure (SpringBoard down) is a verdict.
 */
async function probeHealth(
	input: ClaimInput,
	device: InventoryDevice,
	probe: ((id: string) => AsyncResult<void>) | undefined
): Promise<UnhealthyDevice | undefined> {
	if (!probe) return undefined;
	const first = await probe(device.id);
	if (first.success) return undefined;
	const load = isProbeTimeout(first.error) ? overload(input) : undefined;
	if (!load) return { device, reason: first.error };
	await (input.sleep ?? Bun.sleep)(OVERLOAD_REPROBE_MS);
	const second = await probe(device.id);
	if (second.success) return undefined;
	if (!isProbeTimeout(second.error)) return { device, reason: second.error };
	return { device, reason: `${second.error} (host overloaded)`, skipOnly: true, load };
}

/** Boot (+ wait ready, with `bootReady`) a device this claim must boot: how far it got, or the claim's verdict on it. */
async function bootDevice(
	input: ClaimInput,
	device: InventoryDevice,
	leaseId: string
): Promise<{ booted: "ready" | "booted" } | { failed: Realised }> {
	const { provider, store } = input;
	const readyMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	input.log?.(`${device.name} (${device.id}): booting`);
	if (!provider.bootReady) {
		const booted = await provider.boot(device.id);
		if (!booted.success) return { failed: { ok: booted, leaseId } };
		store.markBootedByOwner(leaseId);
		return { booted: "booted" };
	}
	const result = await provider.bootReady(device.id, readyMs);
	if (result.kind === "boot-failed") return { failed: { ok: err(result.error), leaseId } };
	store.markBootedByOwner(leaseId);
	if (result.kind === "ready") return { booted: "ready" };
	const reason = `not ready within ${Math.round(readyMs / 1000)}s: ${result.error}`;
	return { failed: { ok: err(result.error), leaseId, unhealthy: { device, reason } } };
}

/**
 * A device that was already Booted before this claim needs only the provider's cheap check: this claim
 * did not boot it, so there is nothing to wait for. Any failure (or no such check) means the full
 * `waitReady` + `probe`.
 */
async function isWarm(provider: DeviceProvider, item: Reserved, device: InventoryDevice): Promise<boolean> {
	if (item.action !== "reuse" || device.state !== "booted" || !provider.verifyWarm) return false;
	return (await provider.verifyWarm(device.id)).success;
}

async function realise(input: ClaimInput, item: Reserved): Promise<Realised> {
	const { provider, store, request } = input;
	let lease = item.lease;
	let device: InventoryDevice;
	if (item.action === "create") {
		input.log?.(`creating ${item.name} (${request.profile})`);
		const created = await provider.create(item.name, request.profile, request.runtime);
		if (!created.success) return { ok: created, leaseId: lease.id };
		device = created.data;
		try {
			lease = store.transaction(() => {
				store.deleteLeases([item.lease.id]);
				return store.insertLease(
					{
						resource: deviceResourceOf(device),
						owner: input.owner,
						ttlMs: input.ttlMs,
						...claimField(input),
						...(input.label !== undefined ? { label: input.label } : {}),
						...(input.pid !== undefined ? { pid: input.pid } : {}),
					},
					input.now()
				);
			});
		} catch (error) {
			return { ok: err(error), leaseId: lease.id };
		}
	} else {
		device = item.device;
	}
	let readyBoot = false;
	let bootedNow = false;
	if (item.action !== "reuse" || device.state === "shutdown") {
		await provider.prepareBoot?.(device.id);
		const booted = await bootDevice(input, device, lease.id);
		if ("failed" in booted) return booted.failed;
		lease = { ...lease, bootedByOwner: true };
		bootedNow = true;
		readyBoot = booted.booted === "ready";
		if (readyBoot) await provider.afterReady?.(device.id);
	}
	const realised = readyBoot
		? await probeBooted(input, item, device, lease)
		: await checkReady(input, item, device, lease, bootedNow);
	if (!realised.unhealthy?.skipOnly || lease.bootedByOwner !== true) return realised;
	return { ...realised, unhealthy: { ...realised.unhealthy, bootedByClaim: true } };
}

/** A device `bootReady` saw finish booting: only the provider's post-boot probe is left. */
async function probeBooted(
	input: ClaimInput,
	item: Reserved,
	device: InventoryDevice,
	lease: Lease
): Promise<Realised> {
	const { provider } = input;
	const probe = provider.probeBooted ?? provider.probe;
	const unhealthy = await probeHealth(input, device, probe?.bind(provider));
	if (unhealthy) return { ok: err(unhealthy.reason), leaseId: lease.id, unhealthy };
	return { ok: ok({ lease, device: { ...device, state: "booted" }, action: item.action }), leaseId: lease.id };
}

/** The warm check, else wait until ready, then the full probe. */
async function checkReady(
	input: ClaimInput,
	item: Reserved,
	device: InventoryDevice,
	lease: Lease,
	bootedNow = false
): Promise<Realised> {
	const { provider } = input;
	if (await isWarm(provider, item, device)) {
		return { ok: ok({ lease, device, action: item.action }), leaseId: lease.id };
	}
	const readyMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	input.log?.(`${device.name} (${device.id}): waiting until it is ready`);
	const ready = await provider.waitReady(device.id, readyMs);
	if (!ready.success) {
		// Never ready is unhealthy too: quarantine (or skip) it and claim another, so it is not picked first next time.
		const reason = `not ready within ${Math.round(readyMs / 1000)}s: ${ready.error}`;
		return { ok: ready, leaseId: lease.id, unhealthy: { device, reason } };
	}
	if (bootedNow) await provider.afterReady?.(device.id);
	const unhealthy = await probeHealth(input, device, provider.probe?.bind(provider));
	if (unhealthy) return { ok: err(unhealthy.reason), leaseId: lease.id, unhealthy };
	return { ok: ok({ lease, device: { ...device, state: "booted" }, action: item.action }), leaseId: lease.id };
}

/** `id (name): reason` for each physical device the request would consider that is not usable now. */
function notReadyPhysical(inventory: InventoryDevice[], request: DeviceRequest): string[] {
	if (!request.physical) return [];
	const scope = request.physical.ids ?? request.physical.allow;
	return inventory.flatMap((d) => {
		if (d.platform !== request.platform || (scope !== undefined && !scope.includes(d.id))) return [];
		const reason = physicalNotReadyReason(d);
		return reason === undefined ? [] : [`${d.id} (${d.name}): ${reason}`];
	});
}

function waitMessage(request: DeviceRequest, poolSize: number, notReady: string[] = []): string {
	if (request.physical) {
		const { ids, allow } = request.physical;
		const named = ids?.length ? ` (${ids.join(", ")})` : "";
		const skipped = notReady.length > 0 ? `; not usable: ${notReady.join("; ")}` : "";
		if (ids?.length && notReady.length > 0) {
			return `device_offline: ${notReady.join("; ")}. Connect or unlock it and retry (see warden devices)`;
		}
		const list =
			allow !== undefined
				? ` in the allowlist (${allow.join(", ") || "empty"}; WARDEN_PHYSICAL_IDS / physical.allow)`
				: "";
		return claimError(
			{ code: "NO_DEVICE" },
			`no free ready physical ${request.platform} device${named}${list}: connect and authorize it, or release the lease holding it (see warden devices / warden ls)${skipped}`
		);
	}
	return claimError(
		{ code: "NO_DEVICE" },
		`all ${poolSize} warden-${request.profile} devices leased; max ${request.max} — use --wait or --max`
	);
}

/**
 * `skip`: devices left out for the rest of this claim. `skipOnce`: `skipOnly` devices (slow on an
 * overloaded host), left out of the next round only, so a pool of one is asked again rather than
 * starved. `overload`: the last overloaded reading, while every failure so far was `skipOnly`.
 */
type HealthLog = {
	skip: Set<string>;
	skipOnce: Set<string>;
	reasons: string[];
	overload?: HostLoad | undefined;
	/** failures counted against `MAX_HEALTH_RETRIES`: all but overload skips made while `--wait` time remains */
	spent: number;
};

function overloadMessage(load: HostLoad, reasons: string[]): string {
	const last = reasons.slice(-(MAX_HEALTH_RETRIES + 1));
	return claimError(
		{ code: "NO_CAPACITY", capacityReason: "host-load" },
		`host overloaded (load ${load.load1.toFixed(1)} ≥ ${load.cores} cores); retry later — ${last.join("; ")}`
	);
}

/**
 * Remember devices that failed their probe; the error to give up with once retries are spent. While
 * `waiting` (`--wait` time left), an overload skip is free: the next round asks again, up to the deadline.
 */
function noteUnhealthy(log: HealthLog, bad: UnhealthyDevice[], waiting: boolean): string | undefined {
	for (const b of bad) {
		if (!(b.skipOnly && waiting)) log.spent++;
		const onlySkips = log.reasons.length === 0 || log.overload !== undefined;
		(b.skipOnly ? log.skipOnce : log.skip).add(b.device.id);
		log.reasons.push(b.reason);
		log.overload = b.skipOnly && onlySkips ? b.load : undefined;
	}
	if (log.spent <= MAX_HEALTH_RETRIES) return undefined;
	if (log.overload) return overloadMessage(log.overload, log.reasons);
	return claimError(
		{ code: "HEALTH_FAILED" },
		`${log.reasons.length} device(s) failed the health probe, giving up: ${log.reasons.join("; ")}`
	);
}

async function pause(input: ClaimInput, remainingMs: number): Promise<void> {
	await (input.sleep ?? Bun.sleep)(Math.min(input.pollMs ?? DEFAULT_POLL_MS, remainingMs));
}

/** One `complete` round: the final result, or undefined to claim again without the unhealthy devices. */
async function completeRound(
	input: ClaimInput,
	items: Reserved[],
	reclaimed: string[],
	health: HealthLog,
	deadline: number
): Promise<Result<ClaimOutcome> | undefined> {
	const done = await complete(input, items, reclaimed);
	if (!("retry" in done)) return done;
	const giveUp = noteUnhealthy(health, done.retry, deadline - input.now() > 0);
	return giveUp ? err(giveUp) : undefined;
}

/**
 * Claim `request.count` devices for `owner`. Each round: read the provider inventory, then under the
 * store's `BEGIN IMMEDIATE` lock reclaim stale leases → allocate → insert leases (a placeholder
 * lease for devices still to be created). Boot / create / wait-ready run outside the lock. The
 * `resource_key` UNIQUE constraint is the final guard — a conflict just retries allocation.
 * All-or-nothing: if any device fails, every lease taken by this call is released.
 */
export async function claimDevices(input: ClaimInput): AsyncResult<ClaimOutcome> {
	const queueId = input.queueId ?? `q_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const claimId = input.claimId ?? queueId;
	const requestedAt = input.now();
	const recordRequested = (): void =>
		input.store.recordEvent({
			at: requestedAt,
			type: "requested",
			data: { platform: input.request.platform, profile: input.request.profile, count: input.request.count },
			ownerKey: ownerKey(input.owner),
			claimId,
			...(input.label !== undefined ? { label: input.label } : {}),
		});
	// a keyed claim logs `requested` only once it is a real claim: a repeat that returns the earlier leases logs nothing
	if (input.idempotencyKey === undefined) recordRequested();
	try {
		const keyed = input.idempotencyKey !== undefined;
		return await claimRounds({ ...input, claimId, requestedAt }, queueId, keyed ? recordRequested : undefined);
	} finally {
		if (input.capacity) input.store.dequeue(queueId);
	}
}

async function claimRounds(
	input: ClaimInput,
	queueId: string,
	recordRequested?: () => void
): AsyncResult<ClaimOutcome> {
	let requestedLogged = recordRequested === undefined;
	const startedAt = input.now();
	const deadline = startedAt + input.waitMs;
	const reclaimed: string[] = [];
	const health: HealthLog = { skip: new Set(), skipOnce: new Set(), reasons: [], spent: 0 };
	const round: Round = { deadline, reclaimed, health, noEvict: new Set() };
	let conflicts = 0;

	for (;;) {
		const attempt = await reserveRound(input, queueId, startedAt, round);
		if (!attempt.success) return attempt;
		const reservation = attempt.data;
		if (!requestedLogged && !isKeyedShortcut(reservation)) {
			requestedLogged = true;
			recordRequested?.();
		}
		if (reservation.kind === "conflict" && conflicts++ < MAX_CONFLICT_RETRIES) continue;
		if (reservation.kind === "conflict" || reservation.kind === "error") return err(reservation.error);
		const done = await settle(input, reservation, round);
		if (done) return done;
	}
}

/** A reservation that is the idempotency key's answer, not a claim being made: no `requested` event for it. */
function isKeyedShortcut(reservation: Attempt): boolean {
	return reservation.kind === "existing" || reservation.kind === "key-busy" || reservation.kind === "key-mismatch";
}

/** One round's reads (abort, inventory, capacity) and the reservation under the store lock. */
async function reserveRound(input: ClaimInput, queueId: string, startedAt: number, round: Round): AsyncResult<Attempt> {
	if (input.abort?.()) return err(CLAIM_ABORTED);
	const inventory = await input.provider.inventory();
	if (!inventory.success) return inventory;
	const cap = await readCapacity(input, queueId, startedAt, round.noEvict);
	if (cap && !cap.success) return cap;
	const skip = new Set([...round.health.skip, ...round.health.skipOnce]);
	return ok(tryReserve(input, inventory.data, round.reclaimed, skip, cap?.data));
}

async function readCapacity(
	input: ClaimInput,
	queueId: string,
	enqueuedAt: number,
	noEvict: ReadonlySet<string>
): Promise<Result<CapacityRound> | undefined> {
	const deps = input.capacity;
	if (!deps) return undefined;
	const hostInventory = await deps.hostInventory();
	if (!hostInventory.success) return hostInventory;
	const pressure = deps.pressure ? await deps.pressure() : undefined;
	return ok({
		deps,
		hostInventory: hostInventory.data,
		pressure: pressure?.success ? pressure.data : "normal",
		queueId,
		enqueuedAt,
		noEvict,
	});
}

type Round = {
	deadline: number;
	reclaimed: string[];
	health: HealthLog;
	noEvict: Set<string>;
	/** last queued line logged / reservation seen, so progress prints only on change */
	queuedKey?: string;
	queued?: Extract<Reservation, { kind: "queued" }>;
	/** when the last "waiting for …" line was logged (undefined: none yet) */
	waitLoggedAt?: number;
};

/** Gap between two "still waiting" lines of a claim that polls for a device. */
export const WAIT_PROGRESS_MS = 30_000;

/** What a polling claim waits for, in one line: a device that is not ready, or one that is leased. */
function waitingFor(request: DeviceRequest, reservation: Extract<Reservation, { kind: "wait" }>): string {
	if (!request.physical) return `all ${reservation.poolSize} warden-${request.profile} devices are leased`;
	if (reservation.notReady.length > 0) return `${reservation.notReady.join("; ")}`;
	const named = request.physical.ids?.length ? ` (${request.physical.ids.join(", ")})` : "";
	return `a free ready physical ${request.platform} device${named}`;
}

/** Log that the claim is polling: right away, then about every `WAIT_PROGRESS_MS`, so a wait is never silent. */
function logWaiting(input: ClaimInput, round: Round, what: string, blocked: WaitReason, remainingMs: number): void {
	const now = input.now();
	if (round.waitLoggedAt !== undefined && now - round.waitLoggedAt < WAIT_PROGRESS_MS) return;
	const first = round.waitLoggedAt === undefined;
	round.waitLoggedAt = now;
	const left = formatDuration(remainingMs);
	input.log?.(
		first
			? `waiting for ${what} [${blocked}] (up to ${left}; --no-wait fails at once)`
			: `still waiting for ${what} [${blocked}] (${left} left)`
	);
}

/** After a reservation: the final result, or undefined to go round again (after waiting, or without unhealthy devices). */
async function settle(
	input: ClaimInput,
	reservation: Reservation,
	round: Round
): Promise<Result<ClaimOutcome> | undefined> {
	const { health } = round;
	const skippedOnce = health.skipOnce.size > 0;
	health.skipOnce.clear();
	if (reservation.kind === "existing") return ok({ claimed: reservation.claimed, reclaimed: round.reclaimed });
	if (reservation.kind === "key-mismatch") return err(reservation.message);
	if (reservation.kind === "key-busy") return settleKeyBusy(input, round);
	if (reservation.kind === "limited") return settleLimited(input, reservation.message, round);
	if (reservation.kind === "assign")
		return completeRound(input, reservation.items, round.reclaimed, health, round.deadline);
	if (reservation.kind === "queued") {
		round.queued = reservation;
		const key = `${reservation.position}/${reservation.total}/${reservation.reason}`;
		if (key !== round.queuedKey) {
			round.queuedKey = key;
			const { position, total, reason, blocked } = reservation;
			input.log?.(
				`queued #${position} of ${total} (${priorityName(input.priority ?? PRIORITY.normal)}) — ${reason} [${blocked}]`
			);
		}
		if (reservation.evict.length > 0) {
			await evictIdle(input, reservation.evict, round.noEvict);
			return undefined;
		}
	}
	const remaining = round.deadline - input.now();
	if (remaining <= 0) {
		if (skippedOnce && health.overload) return err(overloadMessage(health.overload, health.reasons));
		if (reservation.kind === "queued") return err(queueTimeout(reservation));
		return err(waitMessage(input.request, reservation.poolSize, reservation.notReady));
	}
	if (reservation.kind === "wait") {
		logWaiting(input, round, waitingFor(input.request, reservation), reservation.blocked, remaining);
	}
	await pause(input, remaining);
	return undefined;
}

/** The earlier claim under this key is still booting: poll until it is granted or gone, else fail when no wait is left. */
async function settleKeyBusy(input: ClaimInput, round: Round): Promise<Result<ClaimOutcome> | undefined> {
	const remaining = round.deadline - input.now();
	const key = input.idempotencyKey ?? "";
	if (remaining <= 0) {
		return err(
			`idempotency key ${key}: an earlier claim with this key is still starting its devices; retry or use --wait`
		);
	}
	logWaiting(input, round, `the earlier claim with idempotency key ${key} to finish`, "device-limit", remaining);
	await pause(input, remaining);
	return undefined;
}

/** A claim over its owner's limit: fail `REQUESTER_LIMIT` when no wait is left, else poll until a claim of the owner ends. */
async function settleLimited(
	input: ClaimInput,
	message: string,
	round: Round
): Promise<Result<ClaimOutcome> | undefined> {
	const remaining = round.deadline - input.now();
	if (remaining <= 0) return err(claimError({ code: "REQUESTER_LIMIT" }, message));
	logWaiting(input, round, "one of this owner's other claims to end", "requester-limit", remaining);
	await pause(input, remaining);
	return undefined;
}

/** Shut down the idle devices the queue head displaced (leases taken under the lock keep them ours meanwhile). */
async function evictIdle(input: ClaimInput, evict: Eviction[], noEvict: Set<string>): Promise<void> {
	const shutdown = input.capacity?.shutdownIdle;
	try {
		for (const { device } of evict) {
			const result = (await shutdown?.(device)) ?? err("no shutdown");
			if (result.success) {
				input.store.recordEvent({
					at: input.now(),
					type: "evicted",
					data: { platform: device.platform, deviceId: device.id, deviceName: device.name },
					resourceKey: resourceKey(deviceResourceOf(device)),
					ownerKey: ownerKey(input.owner),
					...claimField(input),
				});
				input.log?.(`${device.name} (${device.id}): idle, shut down to free capacity for the queue`);
			} else {
				noEvict.add(device.id);
				input.log?.(`${device.name} (${device.id}): could not shut down idle device (${result.error})`);
			}
		}
	} finally {
		input.store.deleteLeases(evict.map((e) => e.leaseId));
	}
}

type Attempt = Reservation | { kind: "conflict"; error: string } | { kind: "error"; error: string };

function tryReserve(
	input: ClaimInput,
	inventory: InventoryDevice[],
	reclaimed: string[],
	skip: ReadonlySet<string>,
	cap?: CapacityRound
): Attempt {
	try {
		return input.store.transaction(() => reserve(input, inventory, reclaimed, skip, cap));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: isUniqueConflict(error) ? "conflict" : "error", error: message };
	}
}

/**
 * Warden-created devices that failed the probe are quarantined and shut down; foreign ones are only
 * skipped (read-only: never recorded, never shut down), and so are slow answers on an overloaded host.
 */
async function quarantineUnhealthy(input: ClaimInput, bad: UnhealthyDevice[]): Promise<void> {
	for (const { device, reason, skipOnly, bootedByClaim } of bad) {
		if (skipOnly) {
			input.log?.(`${device.name} (${device.id}) failed its health probe (${reason}) — skipping it this time`);
			// this claim booted it: don't leave it booted with no lease, adding to the load
			if (bootedByClaim) await input.provider.shutdown(device.id);
			continue;
		}
		if (!device.wardenCreated) {
			input.log?.(`${device.name} (${device.id}) failed its health probe (${reason}) — skipping (not a warden device)`);
			continue;
		}
		input.store.quarantineDevice(
			{
				platform: device.platform,
				id: device.id,
				name: device.name,
				...(device.profile !== undefined ? { profile: device.profile } : {}),
				...(device.runtime !== undefined ? { runtime: device.runtime } : {}),
			},
			`${CLAIM_QUARANTINE_PREFIX}${reason}`,
			input.now()
		);
		input.log?.(
			`${device.name} (${device.id}) failed its health probe (${reason}) — quarantined for 24h; clear now with: warden sim unquarantine ${device.id}`
		);
		await input.provider.shutdown(device.id);
	}
}

/** Undo what a deleted lease left set on the claimed devices; only touches the conditions code when a row exists. */
async function undoClaimedOrphans(input: ClaimInput, claimed: ClaimedDevice[]): Promise<void> {
	const host = input.orphans;
	if (!host) return;
	for (const { device } of claimed) {
		const rows = input.store.db
			.query<{ n: number }, [string, string]>(
				"SELECT COUNT(*) AS n FROM orphan_conditions WHERE platform = ? AND device_id = ?"
			)
			.get(device.platform, device.id);
		if (!rows || rows.n === 0) continue;
		const { undoOrphansWith } = await import("./conditions/orphans");
		const report = await undoOrphansWith(input.store, { now: input.now, pidAlive: input.pidAlive, ...host }, device);
		for (const e of report.errors) input.log?.(`${device.name} (${device.id}): leftover condition not undone — ${e}`);
	}
}

/** The `granted` event of a lease handed out now; `waitMs` runs from when the claim call began. */
function grantedEvent(input: ClaimInput, c: ClaimedDevice, now: number): NewLeaseEvent {
	return {
		at: now,
		type: "granted",
		data: {
			platform: c.device.platform,
			profile: input.request.profile,
			deviceId: c.device.id,
			deviceName: c.device.name,
			action: c.action,
			waitMs: Math.max(0, now - (input.requestedAt ?? now)),
		},
		leaseId: c.lease.id,
		resourceKey: resourceKey(c.lease.resource),
		ownerKey: ownerKey(input.owner),
		...(c.lease.label !== undefined ? { label: c.lease.label } : {}),
		...claimField(input),
	};
}

/**
 * Boot / create / wait-ready / probe every reserved device; all-or-nothing. A failed probe
 * quarantines that device and asks the caller to claim again without it (`retry`).
 */
async function complete(
	input: ClaimInput,
	items: Reserved[],
	reclaimed: string[]
): Promise<Result<ClaimOutcome> | { retry: UnhealthyDevice[] }> {
	const results = await Promise.all(items.map((item) => realise(input, item)));
	const bad = results.flatMap((r) => (r.unhealthy ? [r.unhealthy] : []));
	const failures = results.flatMap((r) => (r.ok.success || r.unhealthy ? [] : [r.ok.error]));
	if (failures.length > 0 || bad.length > 0) {
		// a device this claim booted and skipped keeps its lease until it is shut down again, so no other
		// claim can lease it in between and have it shut down under them
		const held = (r: Realised) => r.unhealthy?.skipOnly === true && r.unhealthy.bootedByClaim === true;
		input.store.deleteLeases(results.filter((r) => !held(r)).map((r) => r.leaseId));
		if (input.claimId !== undefined) input.store.deleteClaimKeysOf(input.claimId);
		try {
			await quarantineUnhealthy(input, bad);
		} finally {
			input.store.deleteLeases(results.filter(held).map((r) => r.leaseId));
		}
		if (failures.length > 0) {
			const message = failures.join("; ");
			return err(failures.every(isRuntimeMissing) ? claimError({ code: "RUNTIME_MISSING" }, message) : message);
		}
		return { retry: bad };
	}
	const claimed = results.flatMap((r) => (r.ok.success ? [r.ok.data] : []));
	await undoClaimedOrphans(input, claimed);
	const now = input.now();
	input.store.transaction(() => {
		input.store.heartbeat(
			claimed.map((c) => c.lease.id),
			now
		);
		for (const c of claimed) input.store.recordEvent(grantedEvent(input, c, now));
		if (input.claimId !== undefined) input.store.markClaimKeyReady(input.claimId);
	});
	for (const c of claimed) input.store.touchDevice(c.device.platform, c.device.id, now);
	const leases = claimed.map((c) => ({ ...c, lease: { ...c.lease, heartbeatAt: now } }));
	return ok({ claimed: leases, reclaimed });
}
