import { type Budget, type CapacityConfig, hostBudget } from "@delacour/warden-core/capacity";
import type { CapacityDeps } from "@delacour/warden-core/claim";
import { type HostFacts, type MemoryPressure, memoryPressure, readHostFacts } from "@delacour/warden-core/host";
import { markWardenDevices } from "@delacour/warden-core/inventory";
import type { InventoryDevice, Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { stopHelperAfter } from "./agent-ui/stop-helper-after";
import type { CommandContext } from "./context";
import { providerFor } from "./providers";

export const CAPACITY_PLATFORMS: readonly Platform[] = ["ios", "android"];

/** `WARDEN_CAPACITY=off` (or 0 / false / no) turns the gate and the boot queue off. */
export function capacityEnabled(env: Record<string, string | undefined>): boolean {
	const value = env.WARDEN_CAPACITY?.trim().toLowerCase();
	return !(value === "off" || value === "0" || value === "false" || value === "no");
}

/**
 * Capacity overrides from env: `WARDEN_CAPACITY_MAX` (hard unit cap) and `WARDEN_CAPACITY_HEADROOM_GB`.
 * A bad value is skipped and reported in `problems`. There is no `~/.warden` user config file, and the
 * project `warden.config.ts` is per repo, so env is the one machine-wide override for now.
 */
export function capacityConfigFromEnv(env: Record<string, string | undefined>): {
	config: CapacityConfig;
	problems: string[];
} {
	const config: CapacityConfig = {};
	const problems: string[] = [];
	const read = (name: string, min: number, strict: boolean): number | undefined => {
		const raw = env[name];
		if (raw === undefined || raw.trim() === "") return undefined;
		const n = Number(raw);
		if (!Number.isFinite(n) || (strict ? n <= min : n < min)) {
			problems.push(`${name}=${raw} must be a number ${strict ? ">" : ">="} ${min} — ignored`);
			return undefined;
		}
		return n;
	};
	const max = read("WARDEN_CAPACITY_MAX", 0, true);
	if (max !== undefined) config.max = max;
	const headroom = read("WARDEN_CAPACITY_HEADROOM_GB", 0, false);
	if (headroom !== undefined) config.headroomGb = headroom;
	return { config, problems };
}

/** Host facts + budget + config: what `warden capacity` prints and the claim gate enforces. */
export type CapacityBasis = { host: HostFacts; budget: Budget; config: CapacityConfig };

export async function readCapacityBasis(ctx: CommandContext): Promise<CapacityBasis> {
	const { config, problems } = capacityConfigFromEnv(ctx.env);
	for (const problem of problems) ctx.err(`warden: ${problem}`);
	const host = await (ctx.hostFacts?.() ?? readHostFacts(ctx.exec));
	return { host, budget: hostBudget(host, config), config };
}

/** Every device on the host, both platforms; a platform whose toolchain is missing contributes none. */
export function hostInventoryOf(ctx: CommandContext, owner: Owner): () => AsyncResult<InventoryDevice[]> {
	return async () => {
		const lists = await Promise.all(
			CAPACITY_PLATFORMS.map(async (platform): Promise<InventoryDevice[]> => {
				const inventory = await providerFor(platform, ctx, owner).inventory();
				return inventory.success ? markWardenDevices(inventory.data, ctx.store().listDevices(platform)) : [];
			})
		);
		return ok(lists.flat());
	};
}

export const pressureOf = (ctx: CommandContext) => (): AsyncResult<MemoryPressure> => memoryPressure(ctx.exec);

/** Capacity gate deps for a claim; undefined when `WARDEN_CAPACITY=off`. */
export async function buildCapacityDeps(ctx: CommandContext, owner: Owner): Promise<CapacityDeps | undefined> {
	if (!capacityEnabled(ctx.env)) return undefined;
	const { budget, config } = await readCapacityBasis(ctx);
	return {
		budget,
		config,
		hostInventory: hostInventoryOf(ctx, owner),
		pressure: pressureOf(ctx),
		shutdownIdle: async (device) => {
			const result = await providerFor(device.platform, ctx, owner).shutdown(device.id);
			if (!result.success) return err(result.error);
			await stopHelperAfter(ctx)(device.id);
			return ok(undefined);
		},
	};
}
