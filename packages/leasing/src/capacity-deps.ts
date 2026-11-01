import type { InventoryDevice, Owner, Platform } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { type Budget, type CapacityConfig, hostBudget } from "./capacity";
import type { CapacityDeps } from "./claim";
import { closeSimWindowsAfter } from "./close-sim-windows-after";
import { type HostFacts, type MemoryPressure, memoryPressure, readHostFacts } from "./host";
import { markWardenDevices } from "./inventory";
import type { LeaseHost } from "./lease-host";

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

export async function readCapacityBasis(host: LeaseHost): Promise<CapacityBasis> {
	const { config, problems } = capacityConfigFromEnv(host.env);
	for (const problem of problems) host.log?.({ kind: "warn", message: problem });
	const facts = await (host.hostFacts?.() ?? readHostFacts(host.exec));
	return { host: facts, budget: hostBudget(facts, config), config };
}

/** Every device on the host, both platforms; a platform whose toolchain is missing contributes none. */
export function hostInventoryOf(host: LeaseHost, owner: Owner): () => AsyncResult<InventoryDevice[], WardenError> {
	return async () => {
		const lists = await Promise.all(
			CAPACITY_PLATFORMS.map(async (platform): Promise<InventoryDevice[]> => {
				const inventory = await host.providerFor(platform, owner).inventory();
				return inventory.success ? markWardenDevices(inventory.data, host.store().listDevices(platform)) : [];
			})
		);
		return resultFactory.ok(lists.flat());
	};
}

export const pressureOf = (host: Pick<LeaseHost, "exec">) => (): AsyncResult<MemoryPressure, WardenError> =>
	memoryPressure(host.exec);

/** Capacity gate deps for a claim; undefined when `WARDEN_CAPACITY=off`. */
export async function buildCapacityDeps(host: LeaseHost, owner: Owner): Promise<CapacityDeps | undefined> {
	if (!capacityEnabled(host.env)) return undefined;
	const { budget, config } = await readCapacityBasis(host);
	return {
		budget,
		config,
		hostInventory: hostInventoryOf(host, owner),
		pressure: pressureOf(host),
		shutdownIdle: async (device) => {
			const result = await host.providerFor(device.platform, owner).shutdown(device.id);
			if (!result.success) return result;
			await host.stopHelper(device.id);
			// a window left open is cosmetic: the device is down, which is what the gate asked for
			if (device.platform === "ios") await closeSimWindowsAfter(host, [{ udid: device.id, name: device.name }]);
			return resultFactory.ok(undefined);
		},
	};
}
