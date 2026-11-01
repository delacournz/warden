import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leaseModel } from "@delacour/warden-store/types";
import type { CommandContext } from "../context";
import { deviceTarget } from "../hooks/claude-pretool";
import type { uiHelper } from "./helper";
import { cliUiPaths } from "./paths";

/** Loads the functions a stop needs; tests count loads. */
export type HelperLoader = () => Promise<{
	stopHelper: typeof uiHelper.stopHelper;
	stopAndroidHost: typeof uiHelper.stopAndroidHost;
	/** a physical iPhone's runner host; absent in loaders that only know simulators and emulators */
	stopIosRunner?: typeof uiHelper.stopIosRunner;
}>;

/** Whether `state.json` records a resident Android host for `serial` (or, for a physical iPhone, its runner host); plain JSON read: no schema, no driver. */
export type AndroidHostRecorded = (host: Pick<CommandContext, "env">, serial: string) => boolean;

export class UiStopHelperAfter {
	private readonly loadHelper: HelperLoader = async () => (await import("./helper")).uiHelper;

	/** Whether `state.json` has a record under `field` (plain JSON read: no schema, no driver). */
	private recordedField(host: Pick<CommandContext, "env">, id: string, field: "androidHost" | "iosRunner"): boolean {
		try {
			const state: unknown = JSON.parse(readFileSync(join(cliUiPaths.uiDir(host, id), "state.json"), "utf8"));
			return typeof state === "object" && state !== null && field in state;
		} catch {
			return false;
		}
	}

	/** The default `AndroidHostRecorded`: the Android host of a serial, or the runner host of a physical iPhone. */
	private readonly recordedAndroidHost: AndroidHostRecorded = (host, id) => {
		return this.recordedField(host, id, leaseModel.isPhysicalIosId(id) ? "iosRunner" : "androidHost");
	};

	/** Which resident helper a device has: `warden-simd` (simulators), the Android host, or a physical iPhone's runner host. */
	private helperOf(platform: "ios" | "android", udid: string): "simd" | "androidHost" | "iosRunner" {
		if (platform === "android") return "androidHost";
		return leaseModel.isPhysicalIosId(udid) ? "iosRunner" : "simd";
	}

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
	stopHelperAfter(
		ctx: Pick<CommandContext, "env" | "now" | "err">,
		load: HelperLoader = this.loadHelper,
		recorded: AndroidHostRecorded = this.recordedAndroidHost
	): (udid: string) => Promise<void> {
		return async (udid) => {
			const target = deviceTarget(udid);
			if (target.kind !== "device") return;
			const kind = this.helperOf(target.platform, udid);
			if (kind !== "simd" && !recorded(ctx, udid)) return;
			const helper = await load();
			const stop = { simd: helper.stopHelper, androidHost: helper.stopAndroidHost, iosRunner: helper.stopIosRunner }[
				kind
			];
			if (stop === undefined) return;
			// a helper kept running (its command line unreadable) is said so, not reported as stopped in silence
			const { warning } = await stop(ctx, udid);
			if (warning !== undefined) ctx.err(`warden: ${warning}`);
		};
	}
}

export const uiStopHelperAfter = new UiStopHelperAfter();
