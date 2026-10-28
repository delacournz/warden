import type { Lease } from "@delacour/warden-core/types";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { releaseDevices } from "../device-lease";
import { releaseAfter } from "../perf/release-after";
import type { UiDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import { stopAndroidHost, stopHelper } from "./helper";
import { type UiError, uiError } from "./output";
import { runUi, type UiOptionValues, type UiRunEnv } from "./run";
import { readState } from "./state";

export type CloseOptionValues = UiOptionValues & {
	/** `--app` alone = true (the app `open` launched), `--app com.x.y` = that bundle id */
	app?: true | string;
	release?: true;
};

/** Why `close --release` left an attached `warden dev` lease alone. */
function keptWarning(lease: Lease): string {
	const holder = lease.pid === undefined ? "warden dev" : `warden dev (pid ${lease.pid})`;
	return `not released: ${lease.id} belongs to ${holder}; stop warden dev (Ctrl-C) to release it`;
}

/** Release the lease (its `after` stops the helper) or just stop the helper. */
async function endHelper(
	ctx: CommandContext,
	device: UiDevice,
	release: boolean
): Promise<{ stopped: boolean; how: string; warning?: string }> {
	if (!release) return (device.platform === "android" ? stopAndroidHost : stopHelper)(ctx, device.udid);
	await releaseDevices(ctx, [device.lease.id], { after: releaseAfter(ctx, { helper: true }) });
	return { stopped: true, how: "release" };
}

/** `--app`: terminate the app (the given bundle id, else the one `open` launched); its bundle id, or null without `--app`. */
async function terminateApp(
	ctx: CommandContext,
	env: UiRunEnv,
	device: UiDevice,
	app: CloseOptionValues["app"]
): Promise<Result<string | null, UiError>> {
	if (app === undefined) return ok(null);
	const bundleId = typeof app === "string" ? app : readState(ctx, device.udid).app;
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
	return done.success ? ok(bundleId) : done;
}

/** What helper line `close` reports, if any. */
function helperLine(helper: { stopped: boolean; how: string; warning?: string }): string | undefined {
	if (helper.stopped) return `helper stopped (${helper.how})`;
	return helper.warning === undefined ? "helper was not running" : undefined;
}

/**
 * `warden ui close [--app] [--release]`: end this device's `warden ui` session. Stops the helper daemon
 * (≤ ~2.3 s even if it ignores `shutdown`) — closing is the explicit way to end a resident helper, which a plain
 * release leaves to its idle timeout; `--app` terminates the app first; `--release` also releases the lease, unless
 * the call attached to the session's live `warden dev` lease: that one is `warden dev`'s to release (Ctrl-C it).
 */
export function uiClose(ctx: CommandContext, deps: UiDeps, opts: CloseOptionValues): Promise<number> {
	return runUi(ctx, deps, "close", opts, async (device, env) => {
		const terminatedResult = await terminateApp(ctx, env, device, opts.app);
		if (!terminatedResult.success) return terminatedResult;
		const terminated = terminatedResult.data;

		const keep = opts.release === true && device.action === "attached";
		const released = opts.release === true && !keep;
		const helper = await endHelper(ctx, device, released);
		const text = [
			terminated === null ? undefined : `terminated ${terminated}`,
			helperLine(helper),
			released ? `released ${device.lease.id}` : undefined,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");
		return ok({
			device: { udid: device.udid, platform: device.platform, name: device.name },
			result: { app: terminated, helper, released },
			text,
			warnings: [
				...(helper.warning === undefined ? [] : [helper.warning]),
				...(keep ? [keptWarning(device.lease)] : []),
			],
		});
	});
}
