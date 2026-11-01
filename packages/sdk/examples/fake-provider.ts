/**
 * A provider plugin with file-backed devices and a scripted driver: the smallest complete example of the
 * `@delacour/warden-sdk/plugins` surface. A real farm plugin replaces the JSON file with its API and `fakeDriver`
 * with a driver that talks to the remote device. `fake-provider.test.ts` runs it through the driver
 * conformance suite and through the client.
 *
 *   createWardenClient({ providers: [fakeFarm()] }) then leases.claim({ platform: "android", provider: "fake-farm" })
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import { defineProvider, type PluginProvider, type ProviderPlugin } from "../src/plugins/entry";
import type { Driver, InventoryDevice } from "../src/plugins/entry";

export const FAKE_FARM_HOME = driverFixtures.snapshotOf(
	[driverFixtures.el("window", { children: [driverFixtures.el("button", { id: "start", label: "Start" }), driverFixtures.el("text", { label: "Welcome" })] })],
	{ platform: "android" }
);

/** A driver over the farm's fixed home screen. */
export function fakeFarmDriver(id: string): Driver {
	return new FakeDriver({ screens: [FAKE_FARM_HOME], platform: "android", id });
}

/** The plugin: `size` pre-booted devices, `create` adds more, every device opens a {@link fakeFarmDriver}. */
export function fakeFarm(size = 2, name = "fake-farm"): ProviderPlugin & { disposed: () => boolean } {
	let disposed = false;
	const plugin = defineProvider({
		apiVersion: 1,
		name,
		platform: "android",
		setup: (ctx): PluginProvider => {
			// the farm's devices live outside the process, as a real farm's would: a file under the warden home
			const file = join(ctx.home, `${name}.devices.json`);
			const load = (): Map<string, InventoryDevice> => {
				if (existsSync(file)) {
					const rows = JSON.parse(readFileSync(file, "utf8")) as InventoryDevice[];
					return new Map(rows.map((d) => [d.id, d]));
				}
				const seeded = new Map<string, InventoryDevice>();
				for (let i = 1; i <= size; i++) {
					const id = `farm-${i}`;
					seeded.set(id, { platform: "android", id, name: `farm device ${i}`, state: "booted", wardenCreated: false });
				}
				return seeded;
			};
			const save = (devices: Map<string, InventoryDevice>): void => {
				writeFileSync(file, JSON.stringify([...devices.values()]));
			};
			const setState = (id: string, state: InventoryDevice["state"]) => {
				const devices = load();
				const device = devices.get(id);
				if (!device) return { success: false as const, error: { code: "device_unknown" as const, message: `no device ${id}` } };
				devices.set(id, { ...device, state });
				save(devices);
				return { success: true as const, data: undefined };
			};
			return {
				platform: "android",
				inventory: async () => ({ success: true, data: [...load().values()] }),
				create: async (deviceName) => {
					const devices = load();
					const device: InventoryDevice = {
						platform: "android",
						id: `farm-${devices.size + 1}`,
						name: deviceName,
						state: "shutdown",
						wardenCreated: false,
					};
					devices.set(device.id, device);
					save(devices);
					return { success: true, data: device };
				},
				boot: async (id) => setState(id, "booted"),
				waitReady: async () => ({ success: true, data: undefined }),
				shutdown: async (id) => setState(id, "shutdown"),
				driver: async (id) => fakeFarmDriver(id),
			};
		},
		dispose: () => {
			disposed = true;
		},
	});
	return { ...plugin, disposed: () => disposed };
}

/**
 * Config registration: list this module in `warden.config.ts` and every process that loads the config (the SDK,
 * lazily) gets the plugin, with its leases usable across processes:
 *
 *   export default defineConfig({ providers: ["./fake-provider.ts"] });
 */
export default fakeFarm();
