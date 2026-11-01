import type { InventoryDevice, Owner, Platform } from "@delacour/warden-store/types";
import type { WardenError } from "@delacour/warden-types/error";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { type Budget, type CapacityConfig, capacityMath } from "./capacity";
import type { CapacityDeps } from "./claim";
import { SimWindowCloser } from "./close-sim-windows-after";
import { type HostFacts, hostProbe, type MemoryPressure } from "./host";
import { inventoryMarker } from "./inventory";
import type { LeaseHost } from "./lease-host";

export const CAPACITY_PLATFORMS: readonly Platform[] = ["ios", "android"];

/** Host facts + budget + config: what `warden capacity` prints and the claim gate enforces. */
export type CapacityBasis = { host: HostFacts; budget: Budget; config: CapacityConfig };

/** Pure reads of the capacity env knobs. */
export class CapacityEnv {
	/** `WARDEN_CAPACITY=off` (or 0 / false / no) turns the gate and the boot queue off. */
	enabled(env: Record<string, string | undefined>): boolean {
		const value = env.WARDEN_CAPACITY?.trim().toLowerCase();
		return !(value === "off" || value === "0" || value === "false" || value === "no");
	}

	/**
	 * Capacity overrides from env: `WARDEN_CAPACITY_MAX` (hard unit cap) and `WARDEN_CAPACITY_HEADROOM_GB`.
	 * A bad value is skipped and reported in `problems`. There is no `~/.warden` user config file, and the
	 * project `warden.config.ts` is per repo, so env is the one machine-wide override for now.
	 */
	configFromEnv(env: Record<string, string | undefined>): {
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
}

export const capacityEnv = new CapacityEnv();

/** Builds the capacity gate's inputs from a lease host. */
export class CapacityDepsBuilder {
	constructor(private readonly host: LeaseHost) {}

	async basis(): Promise<CapacityBasis> {
		const { host } = this;
		const { config, problems } = capacityEnv.configFromEnv(host.env);
		for (const problem of problems) host.log?.({ kind: "warn", message: problem });
		const facts = await (host.hostFacts?.() ?? hostProbe.readFacts(host.exec));
		return { host: facts, budget: capacityMath.hostBudget(facts, config), config };
	}

	/** Every device on the host, both platforms; a platform whose toolchain is missing contributes none. */
	hostInventoryOf(owner: Owner): () => AsyncResult<InventoryDevice[], WardenError> {
		const { host } = this;
		return async () => {
			const lists = await Promise.all(
				CAPACITY_PLATFORMS.map(async (platform): Promise<InventoryDevice[]> => {
					const inventory = await host.providerFor(platform, owner).inventory();
					return inventory.success ? inventoryMarker.mark(inventory.data, host.store().listDevices(platform)) : [];
				})
			);
			return resultFactory.ok(lists.flat());
		};
	}

	pressure(): () => AsyncResult<MemoryPressure, WardenError> {
		return () => hostProbe.memoryPressure(this.host.exec);
	}

	/** Capacity gate deps for a claim; undefined when `WARDEN_CAPACITY=off`. */
	async build(owner: Owner): Promise<CapacityDeps | undefined> {
		const { host } = this;
		if (!capacityEnv.enabled(host.env)) return undefined;
		const { budget, config } = await this.basis();
		return {
			budget,
			config,
			hostInventory: this.hostInventoryOf(owner),
			pressure: this.pressure(),
			shutdownIdle: async (device) => {
				const result = await host.providerFor(device.platform, owner).shutdown(device.id);
				if (!result.success) return result;
				await host.stopHelper(device.id);
				// a window left open is cosmetic: the device is down, which is what the gate asked for
				if (device.platform === "ios") {
					await new SimWindowCloser(host).after([{ udid: device.id, name: device.name }]);
				}
				return resultFactory.ok(undefined);
			},
		};
	}
}
