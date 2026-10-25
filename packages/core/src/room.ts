import { type AsyncResult, ok } from "@delacour/warden-types/result";
import { type CapacityConfig, deviceCost, fits, totalCost } from "./capacity";
import type { CapacityDeps } from "./claim";
import type { InventoryDevice, Platform } from "./types";

const booted = (d: InventoryDevice): boolean => d.state === "booted" || d.state === "booting";

/**
 * How many more `platform` devices could boot right now: the host's booted devices (foreign included)
 * count as used, then devices are added one at a time until the budget binds. Idle booted devices
 * count as used too (a claim can reuse or evict them), so this undercounts: callers treat it as a floor.
 */
export function roomFor(
	inventory: readonly InventoryDevice[],
	platform: Platform,
	deps: Pick<CapacityDeps, "budget" | "config">,
	slimmed: ReadonlySet<string> = new Set()
): number {
	const { budget, config } = deps;
	const live = inventory.filter(booted);
	const usage = totalCost(
		live.map((d) => d.platform),
		config,
		live.map((d) => d.platform === "ios" && slimmed.has(d.id))
	);
	// new devices count slim: slim is default-on for iOS sims. TODO(SLIM-2): honour --no-slim
	const slim = platform === "ios";
	const cost = deviceCost(platform, config as CapacityConfig, { slim });
	let n = 0;
	for (;;) {
		const next = fits(
			usage,
			totalCost(Array<Platform>(n + 1).fill(platform), config, Array<boolean>(n + 1).fill(slim)),
			budget
		);
		if (!next.fits || cost.cpu + cost.memMb === 0) return n;
		n++;
	}
}

/** `roomFor` over the live host inventory. */
export async function roomNow(deps: CapacityDeps, platform: Platform): AsyncResult<number> {
	const inventory = await deps.hostInventory();
	if (!inventory.success) return inventory;
	return ok(roomFor(inventory.data, platform, deps));
}
