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
import { connectAndroidHost, connectHelper, stopAndroidHost } from "./helper";
import type { UiError } from "./output";
import { ownedPackages } from "./phone";
import { readDumpRoute, writeDumpRoute } from "./state";

/** `WARDEN_ANDROID_HOST=0` drives an Android device in-process (the way before the resident host), else through it. */
export function androidHostFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
	return env.WARDEN_ANDROID_HOST !== "0";
}

/**
 * The real driver for a device. iOS: the device's `warden-simd` daemon (`connectHelper` spawns it on first
 * use, closing the driver only disconnects). Android: the device's resident host (`warden __android-host`,
 * `connectAndroidHost`), which keeps the adb shell, `warden-uiad` and the animation scales open between calls, so a
 * call pays ~10-40 ms for its op instead of ~500 ms of open and close; when the host cannot be started (or
 * `WARDEN_ANDROID_HOST=0`) an in-process driver owned by this command, as before (`openAndroidInProcess`).
 * Lives apart from `driver.ts` and is imported on first use, so a `warden ui` call that never opens a driver
 * (`--help`, no lease, `status`) never loads the engines.
 */
export async function uiDriver(ctx: CommandContext, device: UiDevice): Promise<Result<Driver, UiError>> {
	if (device.platform === "ios") return connectHelper(ctx, device.udid);
	if (androidHostFromEnv(ctx.env)) {
		const hosted = await connectAndroidHost(ctx, device.udid);
		if (hosted.success) return hosted;
		ctx.err(`warden: android host unavailable (${hosted.error.message}); driving ${device.udid} in-process`);
	}
	// a resident host and this driver would evict each other's `warden-uiad`, and this one's close would put the
	// animation scales back under the host: one driver per emulator
	const { warning } = await stopAndroidHost(ctx, device.udid);
	if (warning !== undefined) ctx.err(`warden: ${warning}`);
	return openAndroidInProcess(ctx, device.udid);
}

/**
 * An adb-backed Android driver owned by the caller (closed with it): what `warden __android-host` serves, and the
 * fallback when there is no host. The uiautomator dump route that worked is remembered per device
 * (`android-dump-route`), and the driver's own per-serial state (`$WARDEN_HOME/android/<serial>.json`) keeps the
 * animation scales it must put back when it closes. The resident `warden-uiad` server is on unless
 * `WARDEN_ANDROID_UIAD=0`.
 */
export async function openAndroidInProcess(
	ctx: CommandContext,
	serial: string,
	log?: (line: string) => void
): Promise<Result<Driver, UiError>> {
	const remembered = readDumpRoute(ctx, serial);
	return fromDriver(
		await openAndroidDriver({
			serial,
			adb: androidTools(ctx.env).adb,
			exec: ctx.exec,
			state: createAndroidStateStore({ dir: androidStateDir(wardenHome(ctx.env)) }),
			ownedPackages: ownedPackages(ctx, serial),
			...(uiadFromEnv(ctx.env) ? { uiad: true } : {}),
			...(remembered ? { dumpRoute: remembered } : {}),
			...(log ? { log } : {}),
			onDumpRoute: (route: DumpRoute) => writeDumpRoute(ctx, serial, route),
		})
	);
}
