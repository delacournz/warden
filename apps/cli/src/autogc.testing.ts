import type { Exec } from "@delacour/warden-core/exec";
import type { Store } from "@delacour/warden-core/store";
import { AUTO_GC_META_KEY } from "./autogc";

/**
 * Wrap a fake exec to see when auto-gc ran relative to the claim: `gcBeforeClaim()` says whether
 * auto-gc had already been considered (its throttle stamped in the store) when the claim first read
 * the device list. Pair with `allowAutoGc` and a store with no gc work, so nothing is spawned.
 */
export function autoGcOrder(inner: Exec, store: () => Store): { exec: Exec; gcBeforeClaim: () => boolean | undefined } {
	let seen: boolean | undefined;
	return {
		exec: async (cmd, opts) => {
			const line = cmd.join(" ");
			if (seen === undefined && (line.startsWith("xcrun simctl list devices") || line.endsWith("adb devices -l"))) {
				seen = store().getMeta(AUTO_GC_META_KEY) !== undefined;
			}
			return inner(cmd, opts);
		},
		gcBeforeClaim: () => seen,
	};
}

/** The test context turns background work off; turn it back on so `maybeAutoGc` reaches its throttle. */
export function allowAutoGc(env: Record<string, string | undefined>): Record<string, string | undefined> {
	return { ...env, WARDEN_BACKGROUND: "1" };
}

/** Whether auto-gc was considered at all during the run. */
export function autoGcConsidered(store: Store): boolean {
	return store.getMeta(AUTO_GC_META_KEY) !== undefined;
}
