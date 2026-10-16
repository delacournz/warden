import { ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { releaseDevices } from "../device-lease";
import { fromDriver, type UiDeps } from "./driver";
import { stopHelper } from "./helper";
import { uiError } from "./output";
import { runUi, type UiOptionValues } from "./run";
import { readState } from "./state";
import { stopHelperAfter } from "./stop-helper-after";

export type CloseOptionValues = UiOptionValues & {
	/** `--app` alone = true (the app `open` launched), `--app com.x.y` = that bundle id */
	app?: true | string;
	release?: true;
};

/**
 * `warden ui close [--app] [--release]`: end this device's `warden ui` session. Stops the helper daemon
 * (≤ ~2.3 s even if it ignores `shutdown`) — closing is the explicit way to end a resident helper, which a plain
 * release leaves to its idle timeout; `--app` terminates the app first; `--release` also releases the lease.
 */
export function uiClose(ctx: CommandContext, deps: UiDeps, opts: CloseOptionValues): Promise<number> {
	return runUi(ctx, deps, "close", opts, async (device, env) => {
		let terminated: string | null = null;
		if (opts.app !== undefined) {
			const bundleId = typeof opts.app === "string" ? opts.app : readState(ctx, device.udid).app;
			if (bundleId === undefined) {
				return {
					success: false,
					error: uiError("usage", "no app to close", { hint: "pass --app <bundleId> (or `warden ui open` one first)" }),
				};
			}
			const driver = await env.driver();
			if (!driver.success) return driver;
			const done = fromDriver(await driver.data.app.terminate(bundleId));
			await driver.data.close();
			if (!done.success) return done;
			terminated = bundleId;
		}

		let helper: { stopped: boolean; how: string };
		if (opts.release === true) {
			await releaseDevices(ctx, [device.lease.id], { after: stopHelperAfter(ctx) });
			helper = { stopped: true, how: "release" };
		} else {
			helper = await stopHelper(ctx, device.udid);
		}
		const released = opts.release === true;
		const text = [
			terminated === null ? undefined : `terminated ${terminated}`,
			helper.stopped ? `helper stopped (${helper.how})` : "helper was not running",
			released ? `released ${device.lease.id}` : undefined,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");
		return ok({
			device: { udid: device.udid, platform: device.platform, name: device.name },
			result: { app: terminated, helper, released },
			text,
		});
	});
}
