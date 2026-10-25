import type { Lease } from "@delacour/warden-core/types";
import { ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { releaseDevices } from "../device-lease";
import { releaseAfter } from "../perf/release-after";
import type { UiDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import { stopHelper } from "./helper";
import { uiError } from "./output";
import { runUi, type UiOptionValues } from "./run";
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
	if (!release) return stopHelper(ctx, device.udid);
	await releaseDevices(ctx, [device.lease.id], { after: releaseAfter(ctx, { helper: true }) });
	return { stopped: true, how: "release" };
}

/**
 * `warden ui close [--app] [--release]`: end this device's `warden ui` session. Stops the helper daemon
 * (≤ ~2.3 s even if it ignores `shutdown`) — closing is the explicit way to end a resident helper, which a plain
 * release leaves to its idle timeout; `--app` terminates the app first; `--release` also releases the lease, unless
 * the call attached to the session's live `warden dev` lease: that one is `warden dev`'s to release (Ctrl-C it).
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

		const keep = opts.release === true && device.action === "attached";
		const released = opts.release === true && !keep;
		const helper = await endHelper(ctx, device, released);
		const text = [
			terminated === null ? undefined : `terminated ${terminated}`,
			helper.stopped
				? `helper stopped (${helper.how})`
				: helper.warning === undefined
					? "helper was not running"
					: undefined,
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
