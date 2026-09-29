import { isLeaseAlive, type PidAlive } from "./liveness";
import type { AllocationPlan, AllocationStep, DeviceRequest, InventoryDevice, Lease } from "./types";
import { resourceKey } from "./types";

export type AllocateInput = {
	inventory: InventoryDevice[];
	leases: Lease[];
	request: DeviceRequest;
	now: number;
	pidAlive: PidAlive;
};

/** `iPhone 17 Pro` → `iphone-17-pro`. */
export function profileSlug(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function wardenDeviceName(profile: string, index: number): string {
	return `warden-${profile}-${index}`;
}

/** cores/4, at least 1, capped at 4 (salient's shard heuristic). */
export function defaultMax(cores: number): number {
	return Math.max(1, Math.min(4, Math.floor(cores / 4)));
}

/** `iOS-26-5` / `com.apple…iOS-26-5` / `android-35` → `[26, 5]` / `[35]`. */
function runtimeVersion(runtime: string | undefined): number[] {
	return (runtime?.match(/\d+/g) ?? []).map(Number);
}

export function compareRuntimeDesc(a: InventoryDevice, b: InventoryDevice): number {
	const av = runtimeVersion(a.runtime);
	const bv = runtimeVersion(b.runtime);
	for (let i = 0; i < Math.max(av.length, bv.length); i++) {
		const diff = (bv[i] ?? 0) - (av[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function runtimeMatches(device: InventoryDevice, runtime: string | undefined): boolean {
	if (runtime === undefined || runtime === "latest") return true;
	if (device.runtime === undefined) return false;
	return device.runtime === runtime || device.runtime.endsWith(runtime);
}

function profileMatches(device: InventoryDevice, profile: string): boolean {
	return (device.profile ?? profileSlug(device.name)) === profile;
}

const STATE_RANK: Record<InventoryDevice["state"], number> = { booted: 0, booting: 1, shutdown: 2 };

/**
 * Pure allocation: which devices satisfy `request` given current leases. Free warden devices first
 * (booted before shutdown, newest runtime first), then pool growth up to `max`. Foreign devices are
 * only considered with `adopt`. Stale leases are ignored and returned for reclaim.
 */
export function allocate({ inventory, leases, request, now, pidAlive }: AllocateInput): AllocationPlan {
	const stale = leases.filter((l) => !isLeaseAlive(l, now, pidAlive)).map((l) => l.id);
	const staleSet = new Set(stale);
	const held = new Set(leases.filter((l) => !staleSet.has(l.id)).map((l) => resourceKey(l.resource)));

	const matching = inventory.filter(
		(d) =>
			d.platform === request.platform &&
			(d.wardenCreated || request.adopt === true) &&
			profileMatches(d, request.profile) &&
			runtimeMatches(d, request.runtime)
	);
	const free = matching
		.filter((d) => !held.has(resourceKey({ kind: "device", platform: d.platform, id: d.id, name: d.name })))
		.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || compareRuntimeDesc(a, b));

	const steps: AllocationStep[] = free
		.slice(0, request.count)
		.map((device) => (device.state === "shutdown" ? { action: "boot", device } : { action: "reuse", device }));

	const pool = inventory.filter(
		(d) => d.platform === request.platform && d.wardenCreated && profileMatches(d, request.profile)
	);
	const usedNames = new Set(pool.map((d) => d.name));
	let room = request.max - pool.length;
	let index = 1;
	while (steps.length < request.count && room > 0) {
		while (usedNames.has(wardenDeviceName(request.profile, index))) index++;
		const name = wardenDeviceName(request.profile, index);
		usedNames.add(name);
		steps.push({ action: "create", name });
		room--;
	}

	if (steps.length < request.count) {
		return { kind: "wait", available: steps.length, needed: request.count, stale };
	}
	return { kind: "assign", steps, stale };
}
