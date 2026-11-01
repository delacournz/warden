import type { UiDeviceInfoJson, UiJsonDoc } from "@delacour/warden-sdk/contracts/ui";
import { opErrors } from "@delacour/warden-sdk/ops/errors";
import type { WardenError, WardenErrorCode } from "@delacour/warden-types/error";
import type { CommandContext } from "../context";

/**
 * Exit codes of `warden ui`: 0 ok · 1 failed/usage · 2 lease · 3 engine unavailable · 4 stale ref ·
 * 130 interrupted.
 */
export const UI_EXIT = { ok: 0, failed: 1, lease: 2, engine: 3, staleRef: 4, interrupted: 130 } as const;
export type UiExitCode = (typeof UI_EXIT)[keyof typeof UI_EXIT];

/** Every machine-readable failure of `warden ui` and the exit code it maps to. Later subcommands add codes here. */
export const UI_ERROR_EXIT = {
	usage: UI_EXIT.failed,
	failed: UI_EXIT.failed,
	wait_target_absent: UI_EXIT.failed,
	wait_target_hidden: UI_EXIT.failed,
	wait_target_present: UI_EXIT.failed,
	wait_text_absent: UI_EXIT.failed,
	wait_not_stable: UI_EXIT.failed,
	target_not_found: UI_EXIT.failed,
	no_alert: UI_EXIT.failed,
	device_foreign: UI_EXIT.lease,
	device_busy: UI_EXIT.lease,
	device_unauthorized: UI_EXIT.lease,
	device_offline: UI_EXIT.lease,
	device_locked: UI_EXIT.lease,
	device_not_leased: UI_EXIT.lease,
	no_device_leased: UI_EXIT.lease,
	ambiguous_device: UI_EXIT.lease,
	lease_not_found: UI_EXIT.lease,
	engine_unavailable: UI_EXIT.engine,
	devtools_unavailable: UI_EXIT.engine,
	stale_ref: UI_EXIT.staleRef,
	no_recording: UI_EXIT.failed,
	recording_active: UI_EXIT.failed,
	target_exists: UI_EXIT.failed,
	empty_recording: UI_EXIT.failed,
	verify_failed: UI_EXIT.failed,
	helper_missing: UI_EXIT.failed,
	use_failed: UI_EXIT.failed,
	verify_unavailable: UI_EXIT.failed,
	interrupted: UI_EXIT.interrupted,
	device_unknown: UI_EXIT.lease,
	session_active: UI_EXIT.failed,
	session_not_found: UI_EXIT.failed,
	app_not_found: UI_EXIT.failed,
	unsupported: UI_EXIT.failed,
	not_profileable: UI_EXIT.failed,
	tool_missing: UI_EXIT.engine,
} as const satisfies Record<string, UiExitCode>;

export type UiErrorCode = keyof typeof UI_ERROR_EXIT;

/** `warden ui` reports the SDK's {@link WardenError}: its codes are a superset of {@link UiErrorCode}. */
export type UiError = WardenError;

export type UiDeviceInfo = UiDeviceInfoJson;

/** `--json` envelope: exactly one document on stdout, success or failure (schema: `uiJsonSchema` in `@delacour/warden-sdk/contracts`). */
export type UiJson = UiJsonDoc;

/** What one subcommand run reports; `startedAt` is `ctx.now()` at the start. */
export type UiReport = {
	command: string;
	json: boolean;
	startedAt: number;
	/** what follows `warden ` in text-mode errors and warnings (default `ui <command>`; `warden perf` sets `perf <command>`) */
	label?: string;
};

export type UiSuccess = {
	device: UiDeviceInfo;
	result: unknown;
	/** the human rendering (stdout, no trailing newline) */
	text: string;
	generation?: number;
	warnings?: string[];
	/** exit code when not 0: `is` answers false with 1 and still prints its result */
	exit?: UiExitCode;
	/** set by `runUi`: the shared `warden dev` lease id the device was attached through */
	attachedTo?: string;
};

export class UiOutput {
	private isUiErrorCode(code: WardenErrorCode): code is UiErrorCode {
		return code in UI_ERROR_EXIT;
	}

	/** The exit code of an error; a code `warden ui` has no entry for (an SDK-only code) is a plain failure. */
	exitCodeFor(error: UiError): UiExitCode {
		return this.isUiErrorCode(error.code) ? UI_ERROR_EXIT[error.code] : UI_EXIT.failed;
	}

	uiError(
		code: UiErrorCode,
		message: string,
		extra: { hint?: string; details?: Record<string, unknown> } = {}
	): UiError {
		return opErrors.opError(code, message, extra);
	}

	/** Human form of an error: `message — hint`. */
	errorText(error: UiError): string {
		return error.hint === undefined ? error.message : `${error.message} — ${error.hint}`;
	}

	/** Print a success (JSON envelope, or `text` on stdout; warnings on stderr in text mode) and return exit 0 (or `success.exit`). */
	reportOk(ctx: CommandContext, report: UiReport, success: UiSuccess): UiExitCode {
		if (report.json) {
			const doc: UiJson = {
				ok: true,
				command: report.command,
				device: success.device,
				...(success.generation !== undefined ? { generation: success.generation } : {}),
				durationMs: Math.max(0, ctx.now() - report.startedAt),
				...(success.attachedTo !== undefined ? { attachedTo: success.attachedTo } : {}),
				result: success.result,
				...(success.warnings && success.warnings.length > 0 ? { warnings: success.warnings } : {}),
			};
			ctx.out(JSON.stringify(doc));
			return success.exit ?? UI_EXIT.ok;
		}
		if (success.text.length > 0) ctx.out(success.text);
		for (const w of success.warnings ?? []) ctx.err(ctx.ui.color.yellow(`warden ${report.label ?? "ui"}: ${w}`));
		return success.exit ?? UI_EXIT.ok;
	}

	/** Print a failure (JSON envelope on stdout, or a red line on stderr) and return its exit code. */
	reportError(ctx: CommandContext, report: UiReport, error: UiError, device?: UiDeviceInfo): UiExitCode {
		if (report.json) {
			const doc: UiJson = { ok: false, command: report.command, ...(device ? { device } : {}), error };
			ctx.out(JSON.stringify(doc));
		} else {
			ctx.err(ctx.ui.color.red(`warden ${report.label ?? `ui ${report.command}`}: ${this.errorText(error)}`));
		}
		return this.exitCodeFor(error);
	}
}

export const uiOutput = new UiOutput();
