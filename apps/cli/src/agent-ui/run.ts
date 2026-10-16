import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import type { Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import { resolveUiDevice, type UiDevice, type UiDeviceFlags } from "./device";
import type { UiDeps } from "./driver";
import { reportError, reportOk, type UiError, type UiExitCode, type UiSuccess, uiError } from "./output";
import { DEFAULT_UI_TIMEOUT_MS } from "./ui-options";

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

function parseTimeout(raw: string | undefined): Result<number, UiError> {
	if (raw === undefined) return { success: true, data: DEFAULT_UI_TIMEOUT_MS };
	if (!/^\d+$/.test(raw) || Number(raw) < 1) {
		return { success: false, error: uiError("usage", `--timeout must be a positive integer (ms), got "${raw}"`) };
	}
	return { success: true, data: Number(raw) };
}

/**
 * The shared frame of a `warden ui` subcommand: validate globals, resolve + lease-check the device, run
 * `work`, print the result as text or the `--json` envelope, return the exit code. Any throw becomes a
 * `failed` error (exit 1) so `--json` always gets one document.
 */
export async function runUi(
	ctx: CommandContext,
	deps: UiDeps,
	command: string,
	opts: UiOptionValues,
	work: (device: UiDevice, env: UiRunEnv) => Promise<Result<UiSuccess, UiError>>
): Promise<UiExitCode> {
	const report = { command, json: opts.json === true, startedAt: ctx.now() };
	try {
		const timeout = parseTimeout(opts.timeout);
		if (!timeout.success) return reportError(ctx, report, timeout.error);
		const device = await resolveUiDevice(ctx, opts);
		if (!device.success) return reportError(ctx, report, device.error);
		const info = { udid: device.data.udid, platform: device.data.platform, name: device.data.name };
		let opened: Promise<Result<Driver, UiError>> | undefined;
		const driver = () => {
			opened ??= deps.driver(ctx, device.data);
			return opened;
		};
		try {
			const done = await work(device.data, { timeoutMs: timeout.data, record: opts.record, deps, driver });
			if (!done.success) return reportError(ctx, report, done.error, info);
			return reportOk(ctx, report, done.data);
		} finally {
			const used = opened === undefined ? undefined : await opened;
			if (used?.success) await used.data.close().catch(() => undefined);
		}
	} catch (error) {
		return reportError(ctx, report, uiError("failed", errorMessage(error)));
	}
}
