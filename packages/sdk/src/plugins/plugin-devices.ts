import type { Lease } from "@delacour/warden-store/types";
import type { Core } from "../core";
import type { CapacityInfo, DeviceInfo, DevicesListParams, InventoryEntry } from "../sdk.types";

/** Plugin devices have no host cap: the farm owns its capacity. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

type Platform = DeviceInfo["platform"];
type PluginGroup = { name: string; platform: Platform; devices: DeviceInfo[]; leases: Map<string, Lease> };

/** Plugin-provided devices for `devices.inventory` and `devices.capacity`. */
export class PluginDevices {
	constructor(private readonly core: Core) {}

	/** The plugin devices `devices.inventory` adds to the bundled ones, each with its lease. */
	async inventory(params: DevicesListParams | undefined): Promise<InventoryEntry[]> {
		const rows: InventoryEntry[] = [];
		for (const group of await this.collect(params?.platform)) {
			for (const device of group.devices) {
				if (params?.booted === true && device.state !== "booted") continue;
				const lease = group.leases.get(device.id);
				rows.push({ device, ...(lease ? { lease } : {}) });
			}
		}
		return rows;
	}

	/** One capacity row per plugin (the farm sets the cap, so `max` is unbounded). */
	async capacity(platform: Platform | undefined): Promise<CapacityInfo[]> {
		const queue = this.core.store().listQueue();
		return (await this.collect(platform)).map((group) => {
			const running = group.devices.filter((d) => d.state === "booted" || d.state === "booting").length;
			return {
				platform: group.platform,
				provider: group.name,
				available: UNBOUNDED - running,
				running,
				max: UNBOUNDED,
				queued: queue.filter((q) => q.platform === group.platform).length,
			};
		});
	}

	private leasesOf(name: string): Map<string, Lease> {
		const held = new Map<string, Lease>();
		for (const lease of this.core.store().listLeases()) {
			if (lease.provider === name && lease.resource.kind === "device") held.set(lease.resource.id, lease);
		}
		return held;
	}

	/** Every registered plugin's devices (a plugin that fails to set up or list is skipped with a `warn` event). */
	private async collect(platform: Platform | undefined): Promise<PluginGroup[]> {
		const { core } = this;
		const out: PluginGroup[] = [];
		for (const [name, plugin] of await core.registeredPlugins()) {
			if (platform !== undefined && plugin.platform !== platform) continue;
			try {
				const provider = await core.pluginProvider(name);
				const inventory = await provider.inventory();
				if (!inventory.success) {
					core.emit({ kind: "warn", message: `${name}: skipped (${inventory.error.message})` });
					continue;
				}
				const leases = this.leasesOf(name);
				const devices = inventory.data
					.filter((d) => !d.golden)
					.map(
						(d): DeviceInfo => ({
							platform: d.platform,
							id: d.id,
							name: d.name,
							state: d.state,
							wardenCreated: d.wardenCreated,
							...(d.profile !== undefined ? { profile: d.profile } : {}),
							...(d.runtime !== undefined ? { runtime: d.runtime } : {}),
							leased: leases.has(d.id),
							provider: name,
							...(d.quarantined ? { quarantined: true } : {}),
						})
					);
				out.push({ name, platform: plugin.platform, devices, leases });
			} catch (error) {
				core.emit({ kind: "warn", message: `${name}: skipped (${String(error)})` });
			}
		}
		return out;
	}
}
