import { cloneFromGolden } from "@warden/core/golden/ios-golden";
import { createAndroidProvider } from "@warden/core/providers/android";
import { createIosProvider, shortRuntime } from "@warden/core/providers/ios";
import type { DeviceProvider, ProviderDeps } from "@warden/core/providers/provider.types";
import type { Owner, Platform } from "@warden/core/types";
import type { CommandContext } from "./context";
import { goldenDeps, goldenEnabled, type Sleep } from "./golden-deps";

/**
 * Device provider for `platform`. iOS pool devices are cloned from a golden image (a first-booted,
 * settled sim) unless `WARDEN_GOLDEN=0`; a failed clone falls back to `simctl create`.
 */
export function providerFor(
	platform: Platform,
	ctx: CommandContext,
	owner: Owner,
	opts: { sleep?: Sleep } = {}
): DeviceProvider {
	const deps: ProviderDeps = {
		exec: ctx.exec,
		store: ctx.store(),
		env: ctx.env,
		now: ctx.now,
		owner,
		log: (line) => ctx.err(`warden: ${line}`),
	};
	if (platform === "android") return createAndroidProvider(deps);
	if (!goldenEnabled(ctx.env)) return createIosProvider(deps);
	const golden = goldenDeps(ctx, owner, opts.sleep);
	return createIosProvider(deps, {
		clone: async (name, profile, runtime) => {
			const cloned = await cloneFromGolden(golden, profile, runtime, name);
			return cloned.success
				? { success: true, data: { udid: cloned.data.udid, runtime: shortRuntime(cloned.data.runtimeId) } }
				: cloned;
		},
	});
}
