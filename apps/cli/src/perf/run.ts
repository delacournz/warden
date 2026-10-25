import type { Result } from "@delacour/warden-types/result";
import { reportError, reportOk, type UiError, type UiExitCode, type UiSuccess, uiError } from "../agent-ui/output";
import type { UiOptionValues } from "../agent-ui/run";
import { DEFAULT_UI_TIMEOUT_MS } from "../agent-ui/ui-options";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import {
	defaultPerfDeviceDeps,
	type PerfDeviceDeps,
	type PerfDeviceFlags,
	type PerfMode,
	type PerfTarget,
	resolvePerfDevice,
} from "./device";
import { defaultPerfHostDeps, type PerfHostDeps } from "./host";
import { defaultSessionDeps, type SessionDeps } from "./session";

/** Everything `warden perf` subcommands reach the outside world through; tests inject fakes. */
export type PerfDeps = {
	device: PerfDeviceDeps;
	session: SessionDeps;
	host: PerfHostDeps;
};

export const defaultPerfDeps: PerfDeps = {
	device: defaultPerfDeviceDeps,
	session: defaultSessionDeps,
	host: defaultPerfHostDeps,
};

/** Values `withPerfOptions` parses to. */
export type PerfOptionValues = Omit<UiOptionValues, "record"> & PerfDeviceFlags & { app?: string };

export type PerfRunEnv = { timeoutMs: number; deps: PerfDeps };

function parseTimeout(raw: string | undefined): Result<number, UiError> {
	if (raw === undefined) return { success: true, data: DEFAULT_UI_TIMEOUT_MS };
	if (!/^\d+$/.test(raw) || Number(raw) < 1) {
		return { success: false, error: uiError("usage", `--timeout must be a positive integer (ms), got "${raw}"`) };
	}
	return { success: true, data: Number(raw) };
}

/**
 * The shared frame of a device-bound `warden perf` subcommand: validate, `resolvePerfDevice` (`observe` or
 * `mutate`), run `work`, print text or the `--json` `UiJson` envelope, return the exit code (the `warden ui`
 * codes: 0 ok · 1 failed/usage · 2 lease). Any throw becomes a `failed` error so `--json` always gets one document.
 */
export async function runPerf(
	ctx: CommandContext,
	deps: PerfDeps,
	command: string,
	mode: PerfMode,
	opts: PerfOptionValues,
	work: (target: PerfTarget, env: PerfRunEnv) => Promise<Result<UiSuccess, UiError>>
): Promise<UiExitCode> {
	const report = {
		command: `perf ${command}`,
		label: `perf ${command}`,
		json: opts.json === true,
		startedAt: ctx.now(),
	};
	try {
		const timeout = parseTimeout(opts.timeout);
		if (!timeout.success) return reportError(ctx, report, timeout.error);
		const target = await resolvePerfDevice(ctx, opts, mode, deps.device);
		if (!target.success) return reportError(ctx, report, target.error);
		const info = { udid: target.data.udid, platform: target.data.platform, name: target.data.name };
		const done = await work(target.data, { timeoutMs: timeout.data, deps });
		if (!done.success) return reportError(ctx, report, done.error, info);
		return reportOk(ctx, report, done.data);
	} catch (error) {
		return reportError(ctx, report, uiError("failed", errorMessage(error)));
	}
}
