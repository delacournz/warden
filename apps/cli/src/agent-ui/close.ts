import { DeviceReleaser } from "@delacour/warden-leasing/device-lease";
import { type Lease, leaseModel } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { perfReleaseAfterCli } from "../perf/release-after";
import type { UiDevice } from "./device";
import { opErrors, type UiDeps } from "./driver";
import { uiHelper } from "./helper";
import { type UiError, uiOutput } from "./output";
import { type UiOptionValues, type UiRunEnv, uiRun } from "./run";
import { uiStatePersistence } from "./state";

export type CloseOptionValues = UiOptionValues & {
	/** `--app` alone = true (the app `open` launched), `--app com.x.y` = that bundle id */
	app?: true | string;
	release?: true;
};

export class UiClose {
	/** Why `close --release` left an attached `warden dev` lease alone. */
	private keptWarning(lease: Lease): string {
		const holder = lease.pid === undefined ? "warden dev" : `warden dev (pid ${lease.pid})`;
		return `not released: ${lease.id} belongs to ${holder}; stop warden dev (Ctrl-C) to release it`;
	}

	/** The resident helper a device's session runs on: the Android host, a physical iPhone's runner host, or `warden-simd`. */
	stopperFor(
		device: UiDevice
	): (host: Parameters<typeof uiHelper.stopHelper>[0], id: string) => ReturnType<typeof uiHelper.stopHelper> {
		if (device.platform === "android") return uiHelper.stopAndroidHost;
		return leaseModel.isPhysicalIosId(device.udid) ? uiHelper.stopIosRunner : uiHelper.stopHelper;
	}

	/** Release the lease (its `after` stops the helper) or just stop the helper. */
	private async endHelper(
		ctx: CommandContext,
		device: UiDevice,
		release: boolean
	): Promise<{ stopped: boolean; how: string; warning?: string }> {
		if (!release) return this.stopperFor(device)(ctx, device.udid);
		await new DeviceReleaser(ctx).release([device.lease.id], {
			after: perfReleaseAfterCli.releaseAfter(ctx, { helper: true }),
		});
		return { stopped: true, how: "release" };
	}

	/** `--app`: terminate the app (the given bundle id, else the one `open` launched); its bundle id, or null without `--app`. */
	private async terminateApp(
		ctx: CommandContext,
		env: UiRunEnv,
		device: UiDevice,
		app: CloseOptionValues["app"]
	): Promise<Result<string | null, UiError>> {
		if (app === undefined) return resultFactory.ok(null);
		const bundleId = typeof app === "string" ? app : uiStatePersistence.readState(ctx, device.udid).app;
		if (bundleId === undefined) {
			return {
				success: false,
				error: uiOutput.uiError("usage", "no app to close", {
					hint: "pass --app <bundleId> (or `warden ui open` one first)",
				}),
			};
		}
		const driver = await env.driver();
		if (!driver.success) return driver;
		const done = opErrors.fromDriver(await driver.data.app.terminate(bundleId));
		await driver.data.close();
		return done.success ? resultFactory.ok(bundleId) : done;
	}

	/** What helper line `close` reports, if any. */
	private helperLine(helper: { stopped: boolean; how: string; warning?: string }): string | undefined {
		if (helper.stopped) return `helper stopped (${helper.how})`;
		return helper.warning === undefined ? "helper was not running" : undefined;
	}

	/**
	 * `warden ui close [--app] [--release]`: end this device's `warden ui` session. Stops the helper daemon
	 * (≤ ~2.3 s even if it ignores `shutdown`) — closing is the explicit way to end a resident helper, which a plain
	 * release leaves to its idle timeout; `--app` terminates the app first; `--release` also releases the lease, unless
	 * the call attached to the session's live `warden dev` lease: that one is `warden dev`'s to release (Ctrl-C it).
	 */
	run(ctx: CommandContext, deps: UiDeps, opts: CloseOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "close", opts, async (device, env) => {
			const terminatedResult = await this.terminateApp(ctx, env, device, opts.app);
			if (!terminatedResult.success) return terminatedResult;
			const terminated = terminatedResult.data;

			const keep = opts.release === true && device.action === "attached";
			const released = opts.release === true && !keep;
			const helper = await this.endHelper(ctx, device, released);
			const text = [
				terminated === null ? undefined : `terminated ${terminated}`,
				this.helperLine(helper),
				released ? `released ${device.lease.id}` : undefined,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			return resultFactory.ok({
				device: { udid: device.udid, platform: device.platform, name: device.name },
				result: { app: terminated, helper, released },
				text,
				warnings: [
					...(helper.warning === undefined ? [] : [helper.warning]),
					...(keep ? [this.keptWarning(device.lease)] : []),
				],
			});
		});
	}
}

export const uiClose = new UiClose();
