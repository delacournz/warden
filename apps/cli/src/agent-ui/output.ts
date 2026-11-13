import type { Platform } from "@delacour/warden-core/types";
import type { CommandContext } from "../context";
import type { UiResults } from "../contracts/ui.schema";
import { SCHEMA_VERSIONS } from "../contracts/versions";

/**
 * Exit codes of `warden ui`: 0 ok · 1 failed/usage · 2 lease · 3 engine unavailable · 4 stale ref ·
 * 5-11 a `--claim` that failed (the claim error table, `@delacour/warden-core/claim-errors`) · 130 interrupted.
 */
export const UI_EXIT = {
	ok: 0,
	failed: 1,
	lease: 2,
	engine: 3,
	staleRef: 4,
	noDevice: 5,
	queueTimeout: 6,
	noCapacity: 7,
	requesterLimit: 8,
	runtimeMissing: 9,
	healthFailed: 10,
	leaseLost: 11,
	interrupted: 130,
} as const;
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
	NO_DEVICE: UI_EXIT.noDevice,
	QUEUE_TIMEOUT: UI_EXIT.queueTimeout,
	NO_CAPACITY: UI_EXIT.noCapacity,
	REQUESTER_LIMIT: UI_EXIT.requesterLimit,
	RUNTIME_MISSING: UI_EXIT.runtimeMissing,
	HEALTH_FAILED: UI_EXIT.healthFailed,
	LEASE_LOST: UI_EXIT.leaseLost,
} as const satisfies Record<string, UiExitCode>;

export type UiErrorCode = keyof typeof UI_ERROR_EXIT;

export type UiError = {
	code: UiErrorCode;
	message: string;
	hint?: string;
	details?: Record<string, unknown>;
};

export type UiDeviceInfo = { udid: string; platform: Platform; name?: string };

/** The `result` a verb reports: typed (and published) for the verbs in `contracts/ui.schema.ts`, `unknown` for the rest. */
export type UiResultOf<C extends string> = C extends keyof UiResults ? UiResults[C] : unknown;

/** The success envelope of `warden ui <C> --json`. */
export type UiOkJson<C extends string = string> = {
	ok: true;
	/** the `warden.ui` contract version (`https://warden.co.nz/schemas/warden.ui.<command>/<N>.json`) */
	schemaVersion: typeof UI_SCHEMA_VERSION;
	command: C;
	device: UiDeviceInfo;
	generation?: number;
	durationMs: number;
	/** the caller's `warden dev` lease this call used beside it (shared, not taken over; `close --release` keeps it) */
	attachedTo?: string;
	result: UiResultOf<C>;
	warnings?: string[];
};

export type UiFailJson = {
	ok: false;
	schemaVersion: typeof UI_SCHEMA_VERSION;
	command: string;
	device?: UiDeviceInfo;
	error: UiError;
};

/** `--json` envelope: exactly one document on stdout, success or failure. */
export type UiJson<C extends string = string> = UiOkJson<C> | UiFailJson;

/** A versioned verb's document, discriminated on `command` (narrow it and `result` is that verb's). */
export type KnownUiJson = { [C in keyof UiResults]: UiOkJson<C> }[keyof UiResults] | UiFailJson;

export const UI_SCHEMA_VERSION = SCHEMA_VERSIONS["warden.ui"];

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
	/** what follows `warden ` in text-mode errors and warnings (default `ui <command>`; `warden perf` sets `perf <command>`) */
	label?: string;
};

export type UiSuccess<R = unknown> = {
	device: UiDeviceInfo;
	result: R;
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
		const doc: UiOkJson = {
			ok: true,
			schemaVersion: UI_SCHEMA_VERSION,
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
export function reportError(ctx: CommandContext, report: UiReport, error: UiError, device?: UiDeviceInfo): UiExitCode {
	if (report.json) {
		const doc: UiFailJson = {
			ok: false,
			schemaVersion: UI_SCHEMA_VERSION,
			command: report.command,
			...(device ? { device } : {}),
			error,
		};
		ctx.out(JSON.stringify(doc));
	} else {
		ctx.err(ctx.ui.color.red(`warden ${report.label ?? `ui ${report.command}`}: ${errorText(error)}`));
	}
	return exitCodeFor(error);
}
