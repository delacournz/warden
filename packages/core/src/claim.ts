import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { allocate } from "./allocate";
import { DEFAULT_READY_TIMEOUT_MS } from "./config.defaults";
import { markWardenDevices } from "./inventory";
import type { PidAlive } from "./liveness";
import type { DeviceProvider } from "./providers/provider.types";
import type { Store } from "./store";
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
};

export type ClaimedDevice = { lease: Lease; device: InventoryDevice; action: AllocationStep["action"] };

export type ClaimOutcome = { claimed: ClaimedDevice[]; reclaimed: string[] };

type Reserved =
	| { action: "reuse" | "boot"; device: InventoryDevice; lease: Lease }
	| { action: "create"; name: string; lease: Lease };

type Reservation = { kind: "assign"; items: Reserved[] } | { kind: "wait"; poolSize: number };

const DEFAULT_POLL_MS = 2_000;
const MAX_CONFLICT_RETRIES = 5;

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

function reserve(input: ClaimInput, rawInventory: InventoryDevice[], reclaimed: string[]): Reservation {
	const { store, request, owner } = input;
	const now = input.now();
	reclaimed.push(...store.reclaimStale(now, input.pidAlive));
	const leases = store.listLeases();
	const inventory = markWardenDevices(
		withPendingDevices(rawInventory, leases, request.platform),
		store.listDevices(request.platform)
	);
	const plan = allocate({ inventory, leases, request, now, pidAlive: input.pidAlive });
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

type Realised = { ok: Result<ClaimedDevice>; leaseId: string };

async function realise(input: ClaimInput, item: Reserved): Promise<Realised> {
	const { provider, store, request } = input;
	const readyMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
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
	if (item.action !== "reuse" || device.state === "shutdown") {
		const booted = await provider.boot(device.id);
		if (!booted.success) return { ok: booted, leaseId: lease.id };
		store.markBootedByOwner(lease.id);
		lease = { ...lease, bootedByOwner: true };
	}
	const ready = await provider.waitReady(device.id, readyMs);
	if (!ready.success) return { ok: ready, leaseId: lease.id };
	return { ok: ok({ lease, device: { ...device, state: "booted" }, action: item.action }), leaseId: lease.id };
}

function waitMessage(request: DeviceRequest, poolSize: number): string {
	return `all ${poolSize} warden-${request.profile} devices leased; max ${request.max} — use --wait or --max`;
}

/**
 * Claim `request.count` devices for `owner`. Each round: read the provider inventory, then under the
 * store's `BEGIN IMMEDIATE` lock reclaim stale leases → allocate → insert leases (a placeholder
 * lease for devices still to be created). Boot / create / wait-ready run outside the lock. The
 * `resource_key` UNIQUE constraint is the final guard — a conflict just retries allocation.
 * All-or-nothing: if any device fails, every lease taken by this call is released.
 */
export async function claimDevices(input: ClaimInput): AsyncResult<ClaimOutcome> {
	const sleep = input.sleep ?? Bun.sleep;
	const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
	const deadline = input.now() + input.waitMs;
	const reclaimed: string[] = [];
	let conflicts = 0;

	for (;;) {
		const inventory = await input.provider.inventory();
		if (!inventory.success) return inventory;

		const reservation = tryReserve(input, inventory.data, reclaimed);
		const retry = reservation.kind === "conflict" && conflicts++ < MAX_CONFLICT_RETRIES;
		if (retry) continue;
		if (reservation.kind === "conflict" || reservation.kind === "error") return err(reservation.error);
		if (reservation.kind === "assign") return complete(input, reservation.items, reclaimed);

		const remaining = deadline - input.now();
		if (remaining <= 0) return err(waitMessage(input.request, reservation.poolSize));
		await sleep(Math.min(pollMs, remaining));
	}
}

type Attempt = Reservation | { kind: "conflict"; error: string } | { kind: "error"; error: string };

function tryReserve(input: ClaimInput, inventory: InventoryDevice[], reclaimed: string[]): Attempt {
	try {
		return input.store.transaction(() => reserve(input, inventory, reclaimed));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: isUniqueConflict(error) ? "conflict" : "error", error: message };
	}
}

/** Boot / create / wait-ready every reserved device; all-or-nothing. */
async function complete(input: ClaimInput, items: Reserved[], reclaimed: string[]): AsyncResult<ClaimOutcome> {
	const results = await Promise.all(items.map((item) => realise(input, item)));
	const failures = results.flatMap((r) => (r.ok.success ? [] : [r.ok.error]));
	if (failures.length > 0) {
		input.store.deleteLeases(results.map((r) => r.leaseId));
		return err(failures.join("; "));
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
