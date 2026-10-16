import { androidTools } from "@delacour/warden-core/providers/android";
import { wardenHome } from "@delacour/warden-core/store";
import { openAndroidDriver } from "@delacour/warden-e2e/driver/android/android-driver";
import type { DumpRoute } from "@delacour/warden-e2e/driver/android/android-dump";
import { androidStateDir, createAndroidStateStore } from "@delacour/warden-e2e/driver/android/android-state";
import { uiadFromEnv } from "@delacour/warden-e2e/driver/android/uiad-backend";
import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import type { Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import { fromDriver } from "./driver";
import { connectHelper } from "./helper";
import type { UiError } from "./output";
import { readDumpRoute, writeDumpRoute } from "./state";

/**
 * The real driver for a device. iOS: the device's `warden-simd` daemon (`connectHelper` spawns it on first
 * use, closing the driver only disconnects). Android: an adb-backed driver owned by this command (closed with it); the uiautomator dump route that worked
 * is remembered per device (`android-dump-route`) because every `warden ui` call is a fresh process, and the driver's own
 * per-serial state (`$WARDEN_HOME/android/<serial>.json`) keeps the animation scales it must put back when it closes.
 * The resident `warden-uiad` server is on (a start costs about 100 ms against the 2 s of one dump) unless `WARDEN_ANDROID_UIAD=0`.
 * Lives apart from `driver.ts` and is imported on first use, so a `warden ui` call that never opens a driver
 * (`--help`, no lease, `status`) never loads the engines.
 */
export async function uiDriver(ctx: CommandContext, device: UiDevice): Promise<Result<Driver, UiError>> {
	if (device.platform === "ios") return connectHelper(ctx, device.udid);
	const remembered = readDumpRoute(ctx, device.udid);
	return fromDriver(
		await openAndroidDriver({
			serial: device.udid,
			adb: androidTools(ctx.env).adb,
			exec: ctx.exec,
			state: createAndroidStateStore({ dir: androidStateDir(wardenHome(ctx.env)) }),
			...(uiadFromEnv(ctx.env) ? { uiad: true } : {}),
			...(remembered ? { dumpRoute: remembered } : {}),
			onDumpRoute: (route: DumpRoute) => writeDumpRoute(ctx, device.udid, route),
		})
	);
}
