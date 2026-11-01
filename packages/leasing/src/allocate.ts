import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import type {
	AllocationPlan,
	AllocationStep,
	DeviceRequest,
	InventoryDevice,
	Lease,
} from "@delacour/warden-store/types";
import { leaseModel } from "@delacour/warden-store/types";

export type AllocateInput = {
	inventory: InventoryDevice[];
	leases: Lease[];
	request: DeviceRequest;
	now: number;
	pidAlive: PidAlive;
	/** device ids to leave out this round (failed their health probe in this claim) */
	skip?: ReadonlySet<string>;
};

const STATE_RANK: Record<InventoryDevice["state"], number> = { booted: 0, booting: 1, shutdown: 2 };

export class Allocator {
	wardenDeviceName(profile: string, index: number): string {
		return `warden-${profile}-${index}`;
	}

	/** cores/4, at least 1, capped at 4 (salient's shard heuristic). */
	defaultMax(cores: number): number {
		return Math.max(1, Math.min(4, Math.floor(cores / 4)));
	}

	compareRuntimeDesc(a: InventoryDevice, b: InventoryDevice): number {
		const av = this.runtimeVersion(a.runtime);
		const bv = this.runtimeVersion(b.runtime);
		for (let i = 0; i < Math.max(av.length, bv.length); i++) {
			const diff = (bv[i] ?? 0) - (av[i] ?? 0);
			if (diff !== 0) return diff;
		}
		return 0;
	}

	/**
	 * Pure allocation: which devices satisfy `request` given current leases. Free warden devices first
	 * (booted before shutdown, newest runtime first), then pool growth up to `max`. Foreign devices are
	 * only considered with `adopt`. Physical devices are never considered, even with `adopt`, unless
	 * `request.physical` asks for them: then only ready ones, no profile match, and nothing is created. Stale leases are ignored and returned for reclaim.
	 */
	allocate({ inventory, leases, request, now, pidAlive, skip }: AllocateInput): AllocationPlan {
		const stale = leases.filter((l) => !liveness.isLeaseAlive(l, now, pidAlive)).map((l) => l.id);
		const staleSet = new Set(stale);
		const held = new Set(leases.filter((l) => !staleSet.has(l.id)).map((l) => leaseModel.resourceKey(l.resource)));

		const matching = inventory.filter((d) => this.candidate(d, request, skip));
		const free = matching
			.filter(
				(d) => !held.has(leaseModel.resourceKey({ kind: "device", platform: d.platform, id: d.id, name: d.name }))
			)
			.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || this.compareRuntimeDesc(a, b));

		const steps: AllocationStep[] = free
			.slice(0, request.count)
			.map((device) => (device.state === "shutdown" ? { action: "boot", device } : { action: "reuse", device }));

		this.growPool(steps, inventory, request);

		if (steps.length < request.count) {
			return { kind: "wait", available: steps.length, needed: request.count, stale };
		}
		return { kind: "assign", steps, stale };
	}

	private candidate(d: InventoryDevice, request: DeviceRequest, skip: ReadonlySet<string> | undefined): boolean {
		if (d.platform !== request.platform || d.golden === true || d.quarantined === true || skip?.has(d.id) === true) {
			return false;
		}
		if (request.physical) {
			// naming devices beats the allowlist; with neither, any ready physical device
			const pick = request.physical.ids ?? request.physical.allow;
			return (
				leaseModel.isPhysicalReady(d) &&
				(pick === undefined || pick.includes(d.id)) &&
				this.runtimeMatches(d, request.runtime)
			);
		}
		return (
			d.physical === undefined &&
			(d.wardenCreated || request.adopt === true) &&
			this.profileMatches(d, request.profile) &&
			this.runtimeMatches(d, request.runtime)
		);
	}

	/** Append `create` steps for new pool devices while the pool is under `max`. */
	private growPool(steps: AllocationStep[], inventory: InventoryDevice[], request: DeviceRequest): void {
		const pool = inventory.filter(
			(d) =>
				d.platform === request.platform &&
				d.golden !== true &&
				d.physical === undefined &&
				d.wardenCreated &&
				this.profileMatches(d, request.profile)
		);
		const usedNames = new Set(pool.map((d) => d.name));
		// quarantined devices keep their names but free their pool slot so a replacement can be created
		let room = request.physical ? 0 : request.max - pool.filter((d) => d.quarantined !== true).length;
		let index = 1;
		while (steps.length < request.count && room > 0) {
			while (usedNames.has(this.wardenDeviceName(request.profile, index))) index++;
			const name = this.wardenDeviceName(request.profile, index);
			usedNames.add(name);
			steps.push({ action: "create", name });
			room--;
		}
	}

	/** `iOS-26-5` / `com.apple…iOS-26-5` / `android-35` → `[26, 5]` / `[35]`. */
	private runtimeVersion(runtime: string | undefined): number[] {
		return (runtime?.match(/\d+/g) ?? []).map(Number);
	}

	private runtimeMatches(device: InventoryDevice, runtime: string | undefined): boolean {
		if (runtime === undefined || runtime === "latest") return true;
		if (device.runtime === undefined) return false;
		return device.runtime === runtime || device.runtime.endsWith(runtime);
	}

	private profileMatches(device: InventoryDevice, profile: string): boolean {
		return (device.profile ?? leaseModel.profileSlug(device.name)) === profile;
	}
}

export const allocator = new Allocator();
