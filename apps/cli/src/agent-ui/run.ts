import type { Driver } from "@delacour/warden-driver/driver.types";
import type { Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { hookJson } from "../hooks/json";
import { type UiDevice, type UiDeviceFlags, uiDeviceResolver } from "./device";
import type { UiDeps } from "./driver";
import { type UiError, type UiExitCode, type UiSuccess, uiOutput } from "./output";
import { DEFAULT_UI_TIMEOUT_MS } from "./ui-options";

/** Subcommands that only read: a device a live warden process holds is reported on, not refused. */
const READ_ONLY: ReadonlySet<string> = new Set([
	"status",
	"net status",
	"location status",
	"clock status",
	"permission status",
	"timezone status",
	"locale status",
	"a11y status",
	"battery status",
]);

/** Values `withUiOptions` parses to. */
export type UiOptionValues = UiDeviceFlags & { timeout?: string; record: boolean; json?: true };

/** What a subcommand's work function gets besides the device. */
export type UiRunEnv = {
	timeoutMs: number;
	record: boolean;
	deps: UiDeps;
	/** the device's driver, opened on first use (so `status` never needs an engine) and closed when the command ends */
	driver: () => Promise<Result<Driver, UiError>>;
};

export class UiRun {
	private parseTimeout(raw: string | undefined): Result<number, UiError> {
		if (raw === undefined) return { success: true, data: DEFAULT_UI_TIMEOUT_MS };
		if (!/^\d+$/.test(raw) || Number(raw) < 1) {
			return {
				success: false,
				error: uiOutput.uiError("usage", `--timeout must be a positive integer (ms), got "${raw}"`),
			};
		}
		return { success: true, data: Number(raw) };
	}

	/**
	 * The shared frame of a `warden ui` subcommand: validate globals, resolve + lease-check the device, run
	 * `work`, print the result as text or the `--json` envelope, return the exit code. Any throw becomes a
	 * `failed` error (exit 1) so `--json` always gets one document.
	 */
	async runUi(
		ctx: CommandContext,
		deps: UiDeps,
		command: string,
		opts: UiOptionValues,
		work: (device: UiDevice, env: UiRunEnv) => Promise<Result<UiSuccess, UiError>>
	): Promise<UiExitCode> {
		const report = { command, json: opts.json === true, startedAt: ctx.now() };
		try {
			const timeout = this.parseTimeout(opts.timeout);
			if (!timeout.success) return uiOutput.reportError(ctx, report, timeout.error);
			// `status` opens no driver: it reports a busy device instead of refusing
			const exclusive = opts.force !== true && !READ_ONLY.has(command);
			const device = await uiDeviceResolver.resolveUiDevice(ctx, opts, {
				exclusive,
				...(deps.pidAlive ? { pidAlive: deps.pidAlive } : {}),
			});
			if (!device.success) return uiOutput.reportError(ctx, report, device.error);
			const info = { udid: device.data.udid, platform: device.data.platform, name: device.data.name };
			let opened: Promise<Result<Driver, UiError>> | undefined;
			const driver = () => {
				opened ??= deps.driver(ctx, device.data);
				return opened;
			};
			try {
				const done = await work(device.data, { timeoutMs: timeout.data, record: opts.record, deps, driver });
				if (!done.success) return uiOutput.reportError(ctx, report, done.error, info);
				const attachedTo = device.data.action === "attached" ? device.data.lease.id : undefined;
				return uiOutput.reportOk(ctx, report, attachedTo === undefined ? done.data : { ...done.data, attachedTo });
			} finally {
				const used = opened === undefined ? undefined : await opened;
				if (used?.success) await used.data.close().catch(() => undefined);
			}
		} catch (error) {
			return uiOutput.reportError(ctx, report, uiOutput.uiError("failed", hookJson.errorMessage(error)));
		}
	}
}

export const uiRun = new UiRun();
