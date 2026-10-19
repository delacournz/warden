import { androidSnapshotLoaded } from "@delacour/warden-core/golden/android-snapshot-pending";
import { cloneFromGolden } from "@delacour/warden-core/golden/ios-golden";
import { createAndroidProvider } from "@delacour/warden-core/providers/android";
import { createIosProvider, shortRuntime } from "@delacour/warden-core/providers/ios";
import type { DeviceProvider, ProviderDeps } from "@delacour/warden-core/providers/provider.types";
import type { Owner, Platform } from "@delacour/warden-core/types";
import type { CommandContext } from "./context";
import { androidSnapshotFailedHook, androidSnapshotHook, goldenDeps, goldenEnabled, type Sleep } from "./golden-deps";

/**
 * Device provider for `platform`. iOS pool devices are cloned from a golden image (a first-booted,
 * settled sim) unless `WARDEN_GOLDEN=0`; a failed clone falls back to `simctl create`. Android emulators
 * launch from warden's quick-boot snapshot of the AVD when one exists, unless `WARDEN_ANDROID_SNAPSHOT=0` /
 * `android.snapshot: false`; a failed launch from it falls back to a cold boot. Claims never build it
 * (`warden gc` / `warden golden ensure --platform android` do).
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
	if (platform === "android")
		return createAndroidProvider(deps, {
			snapshot: androidSnapshotHook(ctx, owner, opts.sleep),
			snapshotFailed: androidSnapshotFailedHook(ctx, owner, opts.sleep),
			snapshotLoaded: (avd) => androidSnapshotLoaded(ctx.store(), avd),
		});
	if (!goldenEnabled(ctx.env)) return createIosProvider(deps);
	const golden = { ...goldenDeps(ctx, owner, opts.sleep), prewarmHint: true };
	return createIosProvider(deps, {
		clone: async (name, profile, runtime) => {
			const cloned = await cloneFromGolden(golden, profile, runtime, name);
			return cloned.success
				? { success: true, data: { udid: cloned.data.udid, runtime: shortRuntime(cloned.data.runtimeId) } }
				: cloned;
		},
	});
}
