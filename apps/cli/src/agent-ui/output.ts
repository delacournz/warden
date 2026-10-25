import type { Platform } from "@delacour/warden-core/types";
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
} as const satisfies Record<string, UiExitCode>;

export type UiErrorCode = keyof typeof UI_ERROR_EXIT;

export type UiError = {
	code: UiErrorCode;
	message: string;
	hint?: string;
	details?: Record<string, unknown>;
};

export type UiDeviceInfo = { udid: string; platform: Platform; name?: string };

/** `--json` envelope: exactly one document on stdout, success or failure. */
export type UiJson =
	| {
			ok: true;
			command: string;
			device: UiDeviceInfo;
			generation?: number;
			durationMs: number;
			/** the caller's `warden dev` lease this call used beside it (shared, not taken over; `close --release` keeps it) */
			attachedTo?: string;
			result: unknown;
			warnings?: string[];
	  }
	| { ok: false; command: string; device?: UiDeviceInfo; error: UiError };

export function exitCodeFor(error: UiError): UiExitCode {
	return UI_ERROR_EXIT[error.code];
}

export function uiError(
	code: UiErrorCode,
	message: string,
	extra: { hint?: string; details?: Record<string, unknown> } = {}
): UiError {
	return {
		code,
		message,
		...(extra.hint !== undefined ? { hint: extra.hint } : {}),
		...(extra.details !== undefined ? { details: extra.details } : {}),
	};
}

/** Human form of an error: `message — hint`. */
export function errorText(error: UiError): string {
	return error.hint === undefined ? error.message : `${error.message} — ${error.hint}`;
}

/** What one subcommand run reports; `startedAt` is `ctx.now()` at the start. */
export type UiReport = {
	command: string;
	json: boolean;
	startedAt: number;
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

/** Print a success (JSON envelope, or `text` on stdout; warnings on stderr in text mode) and return exit 0 (or `success.exit`). */
export function reportOk(ctx: CommandContext, report: UiReport, success: UiSuccess): UiExitCode {
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
	for (const w of success.warnings ?? []) ctx.err(ctx.ui.color.yellow(`warden ui: ${w}`));
	return success.exit ?? UI_EXIT.ok;
}

/** Print a failure (JSON envelope on stdout, or a red line on stderr) and return its exit code. */
export function reportError(ctx: CommandContext, report: UiReport, error: UiError, device?: UiDeviceInfo): UiExitCode {
	if (report.json) {
		const doc: UiJson = { ok: false, command: report.command, ...(device ? { device } : {}), error };
		ctx.out(JSON.stringify(doc));
	} else {
		ctx.err(ctx.ui.color.red(`warden ui ${report.command}: ${errorText(error)}`));
	}
	return exitCodeFor(error);
}
