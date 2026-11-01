/**
 * Public entry of `@delacour/warden-sdk/plugins`: the types a third-party provider or driver implements, and
 * `defineProvider`. Experimental: gated by `apiVersion: 1`.
 *
 * ```ts
 * import { defineProvider } from "@delacour/warden-sdk/plugins";
 * export default defineProvider({ apiVersion: 1, name: "my-farm", platform: "android", setup: (ctx) => myProvider(ctx) });
 * ```
 */

export type {
	AppCommands,
	Driver,
	DriverCapabilities,
	DriverError,
	DriverErrorCode,
	DriverResult,
	Element,
	Snapshot,
} from "@delacour/warden-driver/driver.types";
export type { BootReady, DeviceProvider, ProviderDeps } from "@delacour/warden-providers/provider.types";
export type { InventoryDevice, Platform } from "@delacour/warden-store/types";
export {
	defineProvider,
	type PluginProvider,
	type PluginSetupContext,
	PROVIDER_API_VERSION,
	type ProviderPlugin,
	RESERVED_PROVIDER_NAMES,
} from "./define-provider";
