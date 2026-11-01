import type { Driver } from "@delacour/warden-driver/driver.types";
import type { DeviceProvider, ProviderDeps } from "@delacour/warden-providers/provider.types";
import type { Platform } from "@delacour/warden-store/types";
import { WardenError } from "../errors";

/** Plugin API version this SDK understands. A plugin built for another version is refused (`config_invalid`). */
export const PROVIDER_API_VERSION = 1;

/** Names a plugin may not take: the bundled providers and the reserved hosted one. */
export const RESERVED_PROVIDER_NAMES: readonly string[] = ["ios", "android", "cloud"];

const NAME = /^[a-z][a-z0-9-]*$/;

/** What `setup` receives: the engine's provider deps (exec, store, env, clock, owner, log) plus the client's cwd and home. */
export type PluginSetupContext = ProviderDeps & { cwd: string; home: string };

/**
 * A device backend a plugin supplies: the engine's {@link DeviceProvider} (inventory, create, boot, ...) plus an
 * optional `driver` that opens the {@link Driver} of one of its devices. Without `driver`, `sessions.open` on its
 * leases fails with `engine_unavailable`.
 */
export type PluginProvider = DeviceProvider & {
	driver?: (id: string) => Promise<Driver>;
};

/**
 * A provider plugin for cloud or physical device farms (experimental, `apiVersion: 1`). Register it with
 * `createWardenClient({ providers: [plugin] })`, claim with `leases.claim({ platform, provider: plugin.name })`.
 */
export type ProviderPlugin = {
	apiVersion: 1;
	/** unique, lower-case `[a-z][a-z0-9-]*`; `ios`, `android` and `cloud` are reserved */
	name: string;
	/** the platform its devices run */
	platform: Platform;
	/** build the provider once, on first use */
	setup(context: PluginSetupContext): PluginProvider | Promise<PluginProvider>;
	/** called when the client closes, after `setup` ran */
	dispose?(): void | Promise<void>;
};

/** Check a plugin and return it typed. Throws {@link WardenError} `config_invalid`, `usage` or `duplicate_provider`. */
export function defineProvider(plugin: ProviderPlugin): ProviderPlugin {
	if ((plugin as { apiVersion: number }).apiVersion !== PROVIDER_API_VERSION) {
		throw new WardenError({
			code: "config_invalid",
			message: `provider plugin ${JSON.stringify(plugin.name)} has apiVersion ${String((plugin as { apiVersion: unknown }).apiVersion)}, this SDK supports ${PROVIDER_API_VERSION}`,
			hint: "update the plugin or @delacour/warden-sdk",
		});
	}
	if (!NAME.test(plugin.name)) {
		throw new WardenError({
			code: "usage",
			message: `provider name ${JSON.stringify(plugin.name)} must match ${NAME.source}`,
		});
	}
	if (RESERVED_PROVIDER_NAMES.includes(plugin.name)) {
		throw new WardenError({
			code: "duplicate_provider",
			message: `provider name "${plugin.name}" is reserved for a bundled provider`,
			hint: `pick another name; reserved: ${RESERVED_PROVIDER_NAMES.join(", ")}`,
		});
	}
	return plugin;
}

/** The set of provider plugins one client registered. */
export class ProviderRegistry {
	/** Validate `plugins` and index them by name; a repeated name is `duplicate_provider`. */
	register(plugins: readonly ProviderPlugin[] | undefined): Map<string, ProviderPlugin> {
		const registry = new Map<string, ProviderPlugin>();
		for (const plugin of plugins ?? []) {
			defineProvider(plugin);
			if (registry.has(plugin.name)) {
				throw new WardenError({
					code: "duplicate_provider",
					message: `provider "${plugin.name}" is registered twice`,
				});
			}
			registry.set(plugin.name, plugin);
		}
		return registry;
	}
}

export const providerRegistry = new ProviderRegistry();
