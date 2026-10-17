import { availableParallelism, loadavg } from "node:os";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { allocate } from "./allocate";
import { DEFAULT_READY_TIMEOUT_MS } from "./config.defaults";
import { markWardenDevices } from "./inventory";
import type { PidAlive } from "./liveness";
import { isProbeTimeout } from "./providers/health";
import type { DeviceProvider } from "./providers/provider.types";
import type { DeviceRecord, Store } from "./store";
import type { AllocationStep, DeviceRequest, DeviceResource, InventoryDevice, Lease, Owner, Platform } from "./types";

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
};

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

type Reservation = { kind: "assign"; items: Reserved[] } | { kind: "wait"; poolSize: number };

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
	skip: ReadonlySet<string>
): Reservation {
	const { store, request, owner } = input;
	const now = input.now();
	reclaimed.push(...store.reclaimStale(now, input.pidAlive));
	const leases = store.listLeases();
	const inventory = markWardenDevices(
		withPendingDevices(rawInventory, leases, request.platform),
		liftExpiredQuarantines(input, store.listDevices(request.platform), now)
	);
	const plan = allocate({ inventory, leases, request, now, pidAlive: input.pidAlive, skip });
	if (plan.kind === "wait") {
		const poolSize = inventory.filter(
			(d) => d.platform === request.platform && d.wardenCreated && d.profile === request.profile
		).length;
		return { kind: "wait", poolSize };
	}
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

function claimQuarantineExpired(record: DeviceRecord, now: number): boolean {
	return (
		record.quarantinedAt !== undefined &&
		record.quarantineReason?.startsWith(CLAIM_QUARANTINE_PREFIX) === true &&
		now - record.quarantinedAt >= QUARANTINE_TTL_MS
	);
}

/** Clear claim quarantines older than `QUARANTINE_TTL_MS` (caller holds the store lock); the records as they now are. */
function liftExpiredQuarantines(input: ClaimInput, records: DeviceRecord[], now: number): DeviceRecord[] {
	return records.map((record) => {
		if (!claimQuarantineExpired(record, now)) return record;
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
type UnhealthyDevice = { device: InventoryDevice; reason: string; skipOnly?: true };

function isOverloaded(input: ClaimInput): boolean {
	const { load1, cores } = (input.load ?? hostLoad)();
	return load1 >= cores;
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
	if (!isProbeTimeout(first.error) || !isOverloaded(input)) return { device, reason: first.error };
	await (input.sleep ?? Bun.sleep)(OVERLOAD_REPROBE_MS);
	const second = await probe(device.id);
	if (second.success) return undefined;
	if (!isProbeTimeout(second.error)) return { device, reason: second.error };
	return { device, reason: `${second.error} (host overloaded)`, skipOnly: true };
}

/** Boot (+ wait ready, with `bootReady`) a device this claim must boot: how far it got, or the claim's verdict on it. */
async function bootDevice(
	input: ClaimInput,
	device: InventoryDevice,
	leaseId: string
): Promise<{ booted: "ready" | "booted" } | { failed: Realised }> {
	const { provider, store } = input;
	const readyMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
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
	if (item.action !== "reuse" || device.state === "shutdown") {
		const booted = await bootDevice(input, device, lease.id);
		if ("failed" in booted) return booted.failed;
		lease = { ...lease, bootedByOwner: true };
		readyBoot = booted.booted === "ready";
	}
	return readyBoot ? probeBooted(input, item, device, lease) : checkReady(input, item, device, lease);
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
async function checkReady(input: ClaimInput, item: Reserved, device: InventoryDevice, lease: Lease): Promise<Realised> {
	const { provider } = input;
	if (await isWarm(provider, item, device)) {
		return { ok: ok({ lease, device, action: item.action }), leaseId: lease.id };
	}
	const readyMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const ready = await provider.waitReady(device.id, readyMs);
	if (!ready.success) {
		// Never ready is unhealthy too: quarantine (or skip) it and claim another, so it is not picked first next time.
		const reason = `not ready within ${Math.round(readyMs / 1000)}s: ${ready.error}`;
		return { ok: ready, leaseId: lease.id, unhealthy: { device, reason } };
	}
	const unhealthy = await probeHealth(input, device, provider.probe?.bind(provider));
	if (unhealthy) return { ok: err(unhealthy.reason), leaseId: lease.id, unhealthy };
	return { ok: ok({ lease, device: { ...device, state: "booted" }, action: item.action }), leaseId: lease.id };
}

function waitMessage(request: DeviceRequest, poolSize: number): string {
	return `all ${poolSize} warden-${request.profile} devices leased; max ${request.max} — use --wait or --max`;
}

type HealthLog = { skip: Set<string>; reasons: string[] };

/** Remember devices that failed their probe; the error to give up with once retries are spent. */
function noteUnhealthy(log: HealthLog, bad: { device: InventoryDevice; reason: string }[]): string | undefined {
	for (const b of bad) {
		log.skip.add(b.device.id);
		log.reasons.push(b.reason);
	}
	if (log.reasons.length <= MAX_HEALTH_RETRIES) return undefined;
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
	health: HealthLog
): Promise<Result<ClaimOutcome> | undefined> {
	const done = await complete(input, items, reclaimed);
	if (!("retry" in done)) return done;
	const giveUp = noteUnhealthy(health, done.retry);
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
	const deadline = input.now() + input.waitMs;
	const reclaimed: string[] = [];
	const health: HealthLog = { skip: new Set(), reasons: [] };
	let conflicts = 0;

	for (;;) {
		const inventory = await input.provider.inventory();
		if (!inventory.success) return inventory;

		const reservation = tryReserve(input, inventory.data, reclaimed, health.skip);
		if (reservation.kind === "conflict" && conflicts++ < MAX_CONFLICT_RETRIES) continue;
		if (reservation.kind === "conflict" || reservation.kind === "error") return err(reservation.error);
		const done = await settle(input, reservation, { deadline, reclaimed, health });
		if (done) return done;
	}
}

type Round = { deadline: number; reclaimed: string[]; health: HealthLog };

/** After a reservation: the final result, or undefined to go round again (after waiting, or without unhealthy devices). */
async function settle(
	input: ClaimInput,
	reservation: Extract<Attempt, { kind: "assign" | "wait" }>,
	round: Round
): Promise<Result<ClaimOutcome> | undefined> {
	if (reservation.kind === "assign") return completeRound(input, reservation.items, round.reclaimed, round.health);
	const remaining = round.deadline - input.now();
	if (remaining <= 0) return err(waitMessage(input.request, reservation.poolSize));
	await pause(input, remaining);
	return undefined;
}

type Attempt = Reservation | { kind: "conflict"; error: string } | { kind: "error"; error: string };

function tryReserve(
	input: ClaimInput,
	inventory: InventoryDevice[],
	reclaimed: string[],
	skip: ReadonlySet<string>
): Attempt {
	try {
		return input.store.transaction(() => reserve(input, inventory, reclaimed, skip));
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
	for (const { device, reason, skipOnly } of bad) {
		if (skipOnly) {
			input.log?.(`${device.name} (${device.id}) failed its health probe (${reason}) — skipping it this time`);
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
		input.store.deleteLeases(results.map((r) => r.leaseId));
		await quarantineUnhealthy(input, bad);
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
