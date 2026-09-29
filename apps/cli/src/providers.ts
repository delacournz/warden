import { createAndroidProvider } from "@warden/core/providers/android";
import { createIosProvider } from "@warden/core/providers/ios";
import type { DeviceProvider } from "@warden/core/providers/provider.types";
import type { Owner, Platform } from "@warden/core/types";
import type { CommandContext } from "./context";

export function providerFor(platform: Platform, ctx: CommandContext, owner: Owner): DeviceProvider {
	const deps = { exec: ctx.exec, store: ctx.store(), env: ctx.env, now: ctx.now, owner };
	return platform === "ios" ? createIosProvider(deps) : createAndroidProvider(deps);
}
