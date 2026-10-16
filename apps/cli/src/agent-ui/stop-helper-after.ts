import type { CommandContext } from "../context";
import { deviceTarget } from "../hooks/claude-pretool";
import type { stopHelper } from "./helper";

/** Loads the one function a stop needs; tests count loads. */
export type HelperLoader = () => Promise<{ stopHelper: typeof stopHelper }>;

const loadHelper: HelperLoader = () => import("./helper");

/**
 * `after` hook for `releaseDevices` that stops each released iOS device's `warden-simd`. Used where the helper has
 * to go with the lease: `warden release --shutdown`, `warden ui close --release`, a stale lease reclaimed by gc,
 * a device shut down. A plain release leaves it resident (its idle timeout reaps it), so it passes no hook.
 *
 * `./helper` pulls in the e2e iOS driver, its wire schemas and zod, so it is imported on the first stop and never for
 * an Android serial: commands that only release or gc start without loading any of it.
 */
export function stopHelperAfter(
	ctx: Pick<CommandContext, "env" | "now">,
	load: HelperLoader = loadHelper
): (udid: string) => Promise<void> {
	return async (udid) => {
		const target = deviceTarget(udid);
		if (target.kind !== "device" || target.platform !== "ios") return;
		const { stopHelper } = await load();
		await stopHelper(ctx, udid);
	};
}
