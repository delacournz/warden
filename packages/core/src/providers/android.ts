import { err } from "@warden/types/result";
import type { DeviceProvider, ProviderDeps } from "./provider.types";

/** Stub — implemented in WDN-3. */
export function createAndroidProvider(_deps: ProviderDeps): DeviceProvider {
	const todo = async () => err("android provider not implemented");
	return { platform: "android", inventory: todo, create: todo, boot: todo, waitReady: todo, shutdown: todo };
}
