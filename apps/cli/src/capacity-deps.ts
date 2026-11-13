import { type Budget, type CapacityConfig, hostBudget, UNLIMITED_BUDGET } from "@delacour/warden-core/capacity";
import type { CapacityDeps } from "@delacour/warden-core/claim";
import { type HostFacts, type MemoryPressure, memoryPressure, readHostFacts } from "@delacour/warden-core/host";
import { markWardenDevices } from "@delacour/warden-core/inventory";
import { isCi } from "@delacour/warden-core/owner";
import type { InventoryDevice, Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { stopHelperAfter } from "./agent-ui/stop-helper-after";
import { closeSimWindowsAfter } from "./close-sim-windows-after";
import type { CommandContext } from "./context";
import { providerFor } from "./providers";

export const CAPACITY_PLATFORMS: readonly Platform[] = ["ios", "android"];

/**
 * Host-spec limits (the RAM / CPU budget, the boot queue, a `--max` grown to the budget) are opt-in:
 * `WARDEN_CAPACITY=on` (or 1 / true / yes). Anything else, including unset, enforces nothing and warden
 * boots what is asked for. An explicit `--max` / profile `max` is a user choice and always holds.
 */
export function capacityEnabled(env: Record<string, string | undefined>): boolean {
	const value = env.WARDEN_CAPACITY?.trim().toLowerCase();
	return value === "on" || value === "1" || value === "true" || value === "yes";
}

/**
 * Capacity overrides from env: `WARDEN_CAPACITY_MAX` (hard unit cap) and `WARDEN_CAPACITY_HEADROOM_GB`.
 * In CI the headroom defaults to 0 (a 7 GB runner has nothing to spare); an explicit value wins.
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
	else if (isCi(env)) config.headroomGb = 0;
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

/** The budget something that sizes itself to the host should use: the real one when limits are on, else none. */
export function enforcedBudget(env: Record<string, string | undefined>, basis: CapacityBasis): Budget {
	return capacityEnabled(env) ? basis.budget : UNLIMITED_BUDGET;
}

/** Capacity gate deps for a claim; undefined unless opted in with `WARDEN_CAPACITY=on`. */
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
			// a window left open is cosmetic: the device is down, which is what the gate asked for
			if (device.platform === "ios") await closeSimWindowsAfter(ctx, [{ udid: device.id, name: device.name }]);
			return ok(undefined);
		},
	};
}
