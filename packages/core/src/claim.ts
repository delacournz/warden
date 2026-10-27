import { randomUUID } from "node:crypto";
import { availableParallelism, loadavg } from "node:os";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { allocate } from "./allocate";
import { addCost, type Budget, type CapacityConfig, type Cost, deviceCost, explain, fits, totalCost } from "./capacity";
import { DEFAULT_READY_TIMEOUT_MS } from "./config.defaults";
import type { MemoryPressure } from "./host";
import { markWardenDevices } from "./inventory";
import { isLeaseAlive, type PidAlive } from "./liveness";
import { isProbeTimeout } from "./providers/health";
import type { DeviceProvider } from "./providers/provider.types";
import { PRIORITY, priorityName, queuePosition } from "./queue";
import type { DeviceRecord, Store } from "./store";
import {
	type AllocationStep,
	type DeviceRequest,
	type DeviceResource,
	type InventoryDevice,
	type Lease,
	type Owner,
	type Platform,
	resourceKey,
} from "./types";

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
	/** polled once per round: true ends the claim with `CLAIM_ABORTED` (nothing stays leased or queued) */
	abort?: () => boolean;
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
	| { kind: "wait"; poolSize: number }
	| { kind: "queued"; position: number; total: number; reason: string; evict: Eviction[] };

const DEFAULT_POLL_MS = 2_000;
const MAX_CONFLICT_RETRIES = 5;
/** Re-claims after a device fails its health probe (so up to 3 attempts in all). */
const MAX_HEALTH_RETRIES = 2;

function deviceResource(device: { platform: Platform; id: string; name: string }): DeviceResource {
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
	if (cap) store.reclaimStaleQueue(now, input.pidAlive);
	const plan = allocate({ inventory, leases, request, now, pidAlive: input.pidAlive, skip });
	if (cap && plan.kind === "assign") {
		const gate = admit(input, cap, plan.steps, leases, now);
		if (gate) return gate;
	}
	if (plan.kind === "wait") {
		if (cap) store.dequeue(cap.queueId);
		const poolSize = inventory.filter(
			(d) => d.platform === request.platform && d.wardenCreated && d.profile === request.profile
		).length;
		return { kind: "wait", poolSize };
	}
	if (cap) store.dequeue(cap.queueId);
	const common = { owner, ...(input.label !== undefined ? { label: input.label } : {}) };
	const items = plan.steps.map((step): Reserved => {
		if (step.action === "create") {
			const placeholder = { platform: request.platform, id: `${PENDING_PREFIX}${step.name}`, name: step.name };
			const lease = store.insertLease(
				{
					resource: deviceResource(placeholder),
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
				resource: deviceResource(step.device),
				...common,
				ttlMs: input.ttlMs,
				...(input.pid !== undefined ? { pid: input.pid } : {}),
			},
			now
		);
		return { action: step.action, device: step.device, lease };
	});
	return { kind: "assign", items };
}

const bootedState = (d: InventoryDevice): boolean => d.state === "booted" || d.state === "booting";

/** Cost of everything booted or booting on the host (foreign included) plus creates not yet visible in it. */
function hostUsage(cap: CapacityRound, leases: Lease[], slimmed: ReadonlySet<string>, slimCreates: boolean): Cost {
	const live = cap.hostInventory.filter(bootedState);
	const names = new Set(live.map((d) => d.name));
	const pending = leases.flatMap((l) =>
		l.resource.kind === "device" && l.resource.id.startsWith(PENDING_PREFIX) && !names.has(l.resource.name)
			? [l.resource.platform]
			: []
	);
	// a create still pending counts slim unless the claim opted out (slim is default-on for new iOS sims)
	return totalCost([...live.map((d) => d.platform), ...pending], cap.deps.config, [
		...live.map((d) => d.platform === "ios" && slimmed.has(d.id)),
		...pending.map(() => slimCreates),
	]);
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
	});
	store.refreshQueue(cap.queueId, now);
	const entries = store.listQueue();
	const position = queuePosition(entries, cap.queueId, now) ?? 1;
	const head = position === 1;
	const usage = hostUsage(cap, leases, slimmed, slimCreates);
	const fit = fits(usage, need, budget);
	const held = cap.pressure !== "normal";
	if (head && fit.fits && !held) return undefined;
	const reason = !fit.fits
		? explain(fit, usage, budget)
		: held
			? `memory pressure ${cap.pressure}`
			: "waiting behind higher-priority claims";
	const evict = head && !fit.fits ? pickEvictions(input, cap, steps, leases, usage, need, now) : [];
	return { kind: "queued", position, total: entries.length, reason, evict };
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
	const idle = markWardenDevices(cap.hostInventory, records)
		.filter(
			(d) =>
				d.state === "booted" &&
				d.wardenCreated &&
				d.golden !== true &&
				d.quarantined !== true &&
				!planned.has(d.id) &&
				!cap.noEvict.has(d.id) &&
				!held.has(resourceKey({ kind: "device", platform: d.platform, id: d.id, name: d.name }))
		)
		.sort((a, b) => used(a) - used(b));
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
						resource: deviceResource(device),
						owner: input.owner,
						label: "capacity-evict",
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
		input.store.unquarantineDevice(record.id);
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
						resource: deviceResource(device),
						owner: input.owner,
						ttlMs: input.ttlMs,
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

function waitMessage(request: DeviceRequest, poolSize: number): string {
	return `all ${poolSize} warden-${request.profile} devices leased; max ${request.max} — use --wait or --max`;
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
	return `host overloaded (load ${load.load1.toFixed(1)} ≥ ${load.cores} cores); retry later — ${last.join("; ")}`;
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
	return `${log.reasons.length} device(s) failed the health probe, giving up: ${log.reasons.join("; ")}`;
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
	try {
		return await claimRounds(input, queueId);
	} finally {
		if (input.capacity) input.store.dequeue(queueId);
	}
}

async function claimRounds(input: ClaimInput, queueId: string): AsyncResult<ClaimOutcome> {
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
		if (reservation.kind === "conflict" && conflicts++ < MAX_CONFLICT_RETRIES) continue;
		if (reservation.kind === "conflict" || reservation.kind === "error") return err(reservation.error);
		const done = await settle(input, reservation, round);
		if (done) return done;
	}
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
};

/** After a reservation: the final result, or undefined to go round again (after waiting, or without unhealthy devices). */
async function settle(
	input: ClaimInput,
	reservation: Reservation,
	round: Round
): Promise<Result<ClaimOutcome> | undefined> {
	const { health } = round;
	const skippedOnce = health.skipOnce.size > 0;
	health.skipOnce.clear();
	if (reservation.kind === "assign")
		return completeRound(input, reservation.items, round.reclaimed, health, round.deadline);
	if (reservation.kind === "queued") {
		round.queued = reservation;
		const key = `${reservation.position}/${reservation.total}/${reservation.reason}`;
		if (key !== round.queuedKey) {
			round.queuedKey = key;
			const { position, total, reason } = reservation;
			input.log?.(`queued #${position} of ${total} (${priorityName(input.priority ?? PRIORITY.normal)}) — ${reason}`);
		}
		if (reservation.evict.length > 0) {
			await evictIdle(input, reservation.evict, round.noEvict);
			return undefined;
		}
	}
	const remaining = round.deadline - input.now();
	if (remaining <= 0) {
		if (skippedOnce && health.overload) return err(overloadMessage(health.overload, health.reasons));
		if (reservation.kind === "queued") {
			return err(
				`timed out in the boot queue at #${reservation.position} of ${reservation.total}: ${reservation.reason}`
			);
		}
		return err(waitMessage(input.request, reservation.poolSize));
	}
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
		try {
			await quarantineUnhealthy(input, bad);
		} finally {
			input.store.deleteLeases(results.filter(held).map((r) => r.leaseId));
		}
		if (failures.length > 0) return err(failures.join("; "));
		return { retry: bad };
	}
	const claimed = results.flatMap((r) => (r.ok.success ? [r.ok.data] : []));
	const now = input.now();
	input.store.heartbeat(
		claimed.map((c) => c.lease.id),
		now
	);
	for (const c of claimed) input.store.touchDevice(c.device.platform, c.device.id, now);
	const leases = claimed.map((c) => ({ ...c, lease: { ...c.lease, heartbeatAt: now } }));
	return ok({ claimed: leases, reclaimed });
}
