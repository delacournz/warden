import type { InventoryDevice, Platform } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { type CapacityConfig, capacityMath } from "./capacity";
import type { CapacityDeps } from "./claim";

export class RoomCalculator {
	constructor(private readonly deps: CapacityDeps) {}

	/**
	 * How many more `platform` devices could boot right now: the host's booted devices (foreign included)
	 * count as used, then devices are added one at a time until the budget binds. Idle booted devices
	 * count as used too (a claim can reuse or evict them), so this undercounts: callers treat it as a floor.
	 */
	roomFor(
		inventory: readonly InventoryDevice[],
		platform: Platform,
		slimmed: ReadonlySet<string> = new Set(),
		slimNew = true
	): number {
		const { budget, config } = this.deps;
		const live = inventory.filter((d) => this.booted(d));
		const usage = capacityMath.totalCost(
			live.map((d) => d.platform),
			config,
			live.map((d) => d.platform === "ios" && slimmed.has(d.id))
		);
		// new devices count slim unless the caller opted out: slim is default-on for iOS sims
		const slim = platform === "ios" && slimNew;
		const cost = capacityMath.deviceCost(platform, config as CapacityConfig, { slim });
		let n = 0;
		for (;;) {
			const next = capacityMath.fits(
				usage,
				capacityMath.totalCost(Array<Platform>(n + 1).fill(platform), config, Array<boolean>(n + 1).fill(slim)),
				budget
			);
			if (!next.fits || cost.cpu + cost.memMb === 0) return n;
			n++;
		}
	}

	/** `roomFor` over the live host inventory . */
	async roomNow(platform: Platform, slimNew = true): AsyncResult<number, WardenError> {
		const inventory = await this.deps.hostInventory();
		if (!inventory.success) return inventory;
		return resultFactory.ok(this.roomFor(inventory.data, platform, new Set(), slimNew));
	}

	private booted(d: InventoryDevice): boolean {
		return d.state === "booted" || d.state === "booting";
	}
}
