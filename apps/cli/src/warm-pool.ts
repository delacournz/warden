import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { admissionQueue, queueOrder } from "@delacour/warden-core/queue";
import type { DeviceRecord } from "@delacour/warden-core/store";
import type { DeviceResource, InventoryDevice, Lease, Owner } from "@delacour/warden-core/types";
import {
	computeWarmPlan,
	WARM_BOOT_LABEL,
	WARM_BOOT_TTL_MS,
	WARM_WINDOW_MS,
	type WarmPlan,
	warmDemand,
} from "@delacour/warden-core/warm-pool";
import { mapBounded } from "./bounded";
import { CAPACITY_PLATFORMS, enforcedBudget, hostInventoryOf, pressureOf, readCapacityBasis } from "./capacity-deps";
import type { CommandContext } from "./context";
import { providerFor } from "./providers";

/** how long a warm boot waits for the device to be ready */
const WARM_READY_MS = 120_000;
const WARM_BOOT_CONCURRENCY = 2;

const keyOf = (d: { platform: string; id: string }): string => `${d.platform}:${d.id}`;

/**
 * The warm pool plan for right now: the 24 h peak from the event log, the queue head's profile, memory
 * pressure (unreadable counts as `normal`, like a claim), the host inventory and the capacity budget.
 */
export async function readWarmPlan(ctx: CommandContext, owner: Owner): Promise<WarmPlan> {
	const store = ctx.store();
	const now = ctx.now();
	const basis = await readCapacityBasis(ctx);
	const { config } = basis;
	const budget = enforcedBudget(ctx.env, basis);
	const inventory = await hostInventoryOf(ctx, owner)();
	const pressure = await pressureOf(ctx)();
	const head = queueOrder(admissionQueue(store.listQueue()), now)[0];
	const slimmed = new Set(
		CAPACITY_PLATFORMS.flatMap((p) => store.listDevices(p))
			.filter((r) => r.slimmedAt !== undefined)
			.map((r) => r.id)
	);
	const leased = new Set(
		store
			.listLeases()
			.flatMap((l) => (l.resource.kind === "device" && isLeaseAlive(l, now, processAlive) ? [keyOf(l.resource)] : []))
	);
	return computeWarmPlan({
		demand: warmDemand(store.listEvents({ since: now - WARM_WINDOW_MS }), now),
		...(head !== undefined ? { queueHead: { platform: head.platform, profile: head.profile } } : {}),
		pressure: pressure.success ? pressure.data : "normal",
		devices: inventory.success ? inventory.data : [],
		slimmed,
		leased,
		budget,
		config,
	});
}

/** A short `warm-boot` lease so no claimer takes a half-booted device; undefined when it was taken or is no longer a candidate. */
function holdForWarmBoot(ctx: CommandContext, owner: Owner, device: InventoryDevice): Lease | undefined {
	const store = ctx.store();
	const resource: DeviceResource = { kind: "device", platform: device.platform, id: device.id, name: device.name };
	return store.transaction(() => {
		if (store.findLeaseByResource(resource)) return undefined;
		const record: DeviceRecord | undefined = store.listDevices(device.platform).find((d) => d.id === device.id);
		if (record === undefined || record.quarantinedAt !== undefined) return undefined;
		return store.insertLease(
			{ resource, owner, ttlMs: WARM_BOOT_TTL_MS, label: WARM_BOOT_LABEL, pid: process.pid },
			ctx.now()
		);
	});
}

/** Boot and wait ready for one device under its lease; a note describes a failure. */
async function warmBoot(ctx: CommandContext, owner: Owner, device: InventoryDevice): Promise<string | undefined> {
	const hold = holdForWarmBoot(ctx, owner, device);
	if (hold === undefined) return `${device.name}: taken, not warm-booted`;
	try {
		const provider = providerFor(device.platform, ctx, owner);
		await provider.prepareBoot?.(device.id);
		if (provider.bootReady) {
			const r = await provider.bootReady(device.id, WARM_READY_MS);
			if (r.kind !== "ready") return `warm boot ${device.name} failed: ${r.error}`;
		} else {
			const booted = await provider.boot(device.id);
			if (!booted.success) return `warm boot ${device.name} failed: ${booted.error}`;
			const ready = await provider.waitReady(device.id, WARM_READY_MS);
			if (!ready.success) return `warm boot ${device.name} failed: ${ready.error}`;
		}
		await provider.afterReady?.(device.id);
		return undefined;
	} finally {
		ctx.store().deleteLeases([hold.id]);
	}
}

/** Boot the plan's devices; the booted ones and gc's notes. */
export async function bootWarm(
	ctx: CommandContext,
	owner: Owner,
	plan: WarmPlan
): Promise<{ booted: InventoryDevice[]; notes: string[] }> {
	const devices = plan.rows.flatMap((r) => r.boot);
	const results = await mapBounded(devices, WARM_BOOT_CONCURRENCY, async (d) => ({
		device: d,
		note: await warmBoot(ctx, owner, d),
	}));
	return {
		booted: results.filter((r) => r.note === undefined).map((r) => r.device),
		notes: results.flatMap((r) => (r.note === undefined ? [] : [r.note])),
	};
}
