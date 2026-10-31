import type { AndroidGoldenDeps, AndroidSnapshotEntry } from "@delacour/warden-core/golden/android-golden";
import type { GoldenDeps } from "@delacour/warden-core/golden/ios-golden";
import type { SimctlSim } from "@delacour/warden-core/sims/list";
import type { Store } from "@delacour/warden-core/store";
import type { Owner, Platform } from "@delacour/warden-core/types";
import type { AsyncResult } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";
import { androidGoldenDeps, goldenDeps, goldenEnabled } from "./golden-deps";

/** gc prunes stale goldens at most this often: working out the current keys reads runtimes, device types and AVD files. */
export const GOLDEN_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
/** store meta key holding when gc last pruned stale goldens (the throttle) */
export const GOLDEN_PRUNED_META_KEY = "golden_pruned_at";

type PruneOpts = { all: boolean; cautious?: boolean };

/** The two prunes, injectable for tests; default = the `warden golden prune` ones, imported lazily. */
export type GoldenPrunes = {
	ios: (deps: GoldenDeps, opts: PruneOpts) => AsyncResult<SimctlSim[]>;
	android: (deps: AndroidGoldenDeps, opts: PruneOpts) => AsyncResult<AndroidSnapshotEntry[]>;
};

const defaultPrunes: GoldenPrunes = {
	ios: async (deps, opts) => (await import("@delacour/warden-core/golden/ios-golden")).pruneGoldens(deps, opts),
	android: async (deps, opts) =>
		(await import("@delacour/warden-core/golden/android-golden")).pruneAndroidSnapshots(deps, opts),
};

export type GoldenPrunePass = { goldens: Array<{ platform: Platform; name: string }> };

/** gc should prune stale goldens: goldens on, `WARDEN_GOLDEN_PRUNE` not `0`, and 24 h since the last prune. */
export function goldenPruneDue(store: Store, env: Record<string, string | undefined>, now: number): boolean {
	if (!goldenEnabled(env) || env.WARDEN_GOLDEN_PRUNE === "0") return false;
	const last = store.getMeta(GOLDEN_PRUNED_META_KEY);
	return last === undefined || now - Number(last) >= GOLDEN_PRUNE_INTERVAL_MS;
}

/**
 * `warden gc`'s golden step: delete stale goldens (an older Xcode runtime, `GOLDEN_RECIPE` or system image left them,
 * GBs each), iOS sims and Android quick-boot snapshots, as `warden golden prune` does. Never the current one, never an
 * AVD with a running emulator. `cautious`: a profile or AVD whose key can't be read keeps everything (a transient
 * simctl failure must not look like a removed runtime). `lockWaitMs: 0`: a golden build or clone holding the lock
 * means skip, never wait. A failing platform (no Xcode, no SDK, lock busy) is silent: `warden golden prune` reports.
 * Throttled to `GOLDEN_PRUNE_INTERVAL_MS`; stamped whatever happened, so a machine without Xcode isn't retried every pass.
 */
export async function goldenPrunePass(
	ctx: CommandContext,
	owner: Owner,
	prunes: GoldenPrunes = defaultPrunes
): Promise<GoldenPrunePass> {
	const store = ctx.store();
	if (!goldenPruneDue(store, ctx.env, ctx.now())) return { goldens: [] };
	const quiet = { log: () => undefined, timing: { lockWaitMs: 0 } };
	const opts = { all: false, cautious: true };
	const [ios, android] = await Promise.all([
		prunes.ios({ ...goldenDeps(ctx, owner), ...quiet }, opts),
		prunes.android({ ...androidGoldenDeps(ctx, owner), ...quiet }, opts),
	]);
	store.setMeta(GOLDEN_PRUNED_META_KEY, String(ctx.now()));
	return {
		goldens: [
			...(ios.success ? ios.data.map((s) => ({ platform: "ios" as const, name: s.name })) : []),
			...(android.success
				? android.data.map((e) => ({ platform: "android" as const, name: `${e.avd}/${e.name}` }))
				: []),
		],
	};
}
