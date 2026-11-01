import { defaultNativeProfilers } from "@delacour/warden-sdk/ops/perf/native";
import { defaultNativeIo } from "@delacour/warden-sdk/ops/perf/native-types";
import type { SessionIo, SessionKit, StartHooks } from "@delacour/warden-sdk/ops/perf/orchestrate";
import { resultFactory } from "@delacour/warden-types/result";
import { type UiError, uiOutput } from "../agent-ui/output";
import { selfCommand } from "../autogc";
import type { CommandContext } from "../context";
import { perfAppCli } from "./app";
import { perfDeviceCli } from "./device";
import type { PerfDeps, PerfOptionValues } from "./run";

export const defaultSessionIo: SessionIo = { ...defaultNativeIo, self: selfCommand };

export const defaultSessionKit: SessionKit = { io: defaultSessionIo, profilers: defaultNativeProfilers };

export class PerfSessionKitCli {
	/** A foreign-device error gets the `--relaunch` hint; any other error passes through. */
	private relaunchDeviceError(e: UiError): UiError {
		if (e.code !== "device_foreign") return e;
		return uiOutput.uiError("device_foreign", e.message, {
			hint: "--relaunch / --reset restart the app, so they need a device you hold or a free one; claim another with warden claim",
		});
	}

	/**
	 * How the CLI resolves what `startPerf` leaves to its caller: the app (flag, foreground, warden.config) and, for
	 * `--relaunch` / `--reset` (they restart the app), a device the caller holds or a free one to lease.
	 */
	startHooks(ctx: CommandContext, deps: PerfDeps, opts: PerfOptionValues): StartHooks {
		return {
			resolveApp: (target, flag) => perfAppCli.resolveApp(ctx, { platform: target.platform, id: target.udid }, flag),
			relaunchTarget: async (target) => {
				const resolved = await perfDeviceCli.resolvePerfDevice(
					ctx,
					{ ...opts, lease: undefined, serial: undefined, udid: target.udid, claim: true },
					"mutate",
					deps.device
				);
				if (!resolved.success) return { success: false, error: this.relaunchDeviceError(resolved.error) };
				const working = resolved.data;
				return resultFactory.ok({
					working,
					tookLease: working.lease !== undefined && !target.ownedByCaller && target.holder === undefined,
				});
			},
		};
	}
}

export const perfSessionKitCli = new PerfSessionKitCli();
