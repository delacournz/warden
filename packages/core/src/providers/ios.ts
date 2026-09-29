import { err } from "@warden/types/result";
import type { DeviceProvider, ProviderDeps } from "./provider.types";

/** Stub — implemented in WDN-2. */
export function createIosProvider(_deps: ProviderDeps): DeviceProvider {
	const todo = async () => err("ios provider not implemented");
	return { platform: "ios", inventory: todo, create: todo, boot: todo, waitReady: todo, shutdown: todo };
}
