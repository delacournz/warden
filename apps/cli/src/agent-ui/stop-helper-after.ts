import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../context";
import { deviceTarget } from "../hooks/claude-pretool";
import type { stopAndroidHost, stopHelper } from "./helper";
import { uiDir } from "./paths";

/** Loads the functions a stop needs; tests count loads. */
export type HelperLoader = () => Promise<{ stopHelper: typeof stopHelper; stopAndroidHost: typeof stopAndroidHost }>;

/** Whether `state.json` records a resident Android host for `serial` (plain JSON read: no schema, no driver). */
export type AndroidHostRecorded = (host: Pick<CommandContext, "env">, serial: string) => boolean;

const loadHelper: HelperLoader = () => import("./helper");

const recordedAndroidHost: AndroidHostRecorded = (host, serial) => {
	try {
		const state: unknown = JSON.parse(readFileSync(join(uiDir(host, serial), "state.json"), "utf8"));
		return typeof state === "object" && state !== null && "androidHost" in state;
	} catch {
		return false;
	}
};

/**
 * `after` hook for `releaseDevices` that stops each released device's resident helper: iOS's `warden-simd`, or the
 * Android host (`warden __android-host`) when one is recorded. Used where the helper has
 * to go with the lease: `warden release --shutdown`, `warden ui close --release`, a stale lease reclaimed by gc,
 * a device shut down. A plain release leaves it resident (its idle timeout reaps it), so it passes no hook.
 *
 * `./helper` pulls in the e2e iOS driver, its wire schemas and zod, so it is imported on the first stop and never for
 * an Android serial without a recorded host: commands that only release or gc start without loading any of it. A helper the stop kept (its
 * command line could not be read) gets its warning on stderr.
 */
export function stopHelperAfter(
	ctx: Pick<CommandContext, "env" | "now" | "err">,
	load: HelperLoader = loadHelper,
	recorded: AndroidHostRecorded = recordedAndroidHost
): (udid: string) => Promise<void> {
	return async (udid) => {
		const target = deviceTarget(udid);
		if (target.kind !== "device") return;
		if (target.platform === "android" && !recorded(ctx, udid)) return;
		const helper = await load();
		const stop = target.platform === "ios" ? helper.stopHelper : helper.stopAndroidHost;
		// a helper kept running (its command line unreadable) is said so, not reported as stopped in silence
		const { warning } = await stop(ctx, udid);
		if (warning !== undefined) ctx.err(`warden: ${warning}`);
	};
}
