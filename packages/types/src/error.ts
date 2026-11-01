import type { ErrorResult, Result } from "./result";

/**
 * Every machine-readable failure code. Seeded from `warden ui`'s `UiError` codes (kept verbatim), plus
 * the codes the lease engine and SDK need to branch on instead of comparing message text.
 */
export const WARDEN_ERROR_CODES = [
	"usage",
	"failed",
	"wait_target_absent",
	"wait_target_hidden",
	"wait_target_present",
	"wait_text_absent",
	"wait_not_stable",
	"target_not_found",
	"no_alert",
	"device_foreign",
	"device_busy",
	"device_unauthorized",
	"device_offline",
	"device_locked",
	"device_not_leased",
	"no_device_leased",
	"ambiguous_device",
	"lease_not_found",
	"engine_unavailable",
	"devtools_unavailable",
	"stale_ref",
	"no_recording",
	"recording_active",
	"target_exists",
	"empty_recording",
	"verify_failed",
	"helper_missing",
	"use_failed",
	"verify_unavailable",
	"device_unknown",
	"session_active",
	"session_not_found",
	"app_not_found",
	"unsupported",
	"not_profileable",
	"tool_missing",
	"interrupted",
	"claim_aborted",
	"probe_timeout",
	"capacity_exhausted",
	"not_found",
	"build_failed",
	"config_invalid",
	"store_incompatible",
	"duplicate_provider",
	"timeout",
] as const;

export type WardenErrorCode = (typeof WARDEN_ERROR_CODES)[number];

export type WardenError = {
	code: WardenErrorCode;
	message: string;
	hint?: string;
	details?: Record<string, unknown>;
	/** true when trying the same call again may succeed */
	retryable?: boolean;
};

export type WardenErrorExtra = Pick<WardenError, "hint" | "details" | "retryable">;

/** A failed `Result` carrying a coded {@link WardenError}. Optional fields are omitted unless given. */
export function wardenErr(
	code: WardenErrorCode,
	message: string,
	extra: WardenErrorExtra = {}
): ErrorResult<WardenError> {
	return {
		success: false,
		error: {
			code,
			message,
			...(extra.hint !== undefined ? { hint: extra.hint } : {}),
			...(extra.details !== undefined ? { details: extra.details } : {}),
			...(extra.retryable !== undefined ? { retryable: extra.retryable } : {}),
		},
	};
}

/** A plain-text failure (or an already coded one) as a {@link WardenError}; text gets `code`. */
export function asWardenError(error: string | WardenError, code: WardenErrorCode = "failed"): WardenError {
	return typeof error === "string" ? { code, message: error } : error;
}

const CODES: ReadonlySet<string> = new Set(WARDEN_ERROR_CODES);

export function isWardenError(value: unknown): value is WardenError {
	if (typeof value !== "object" || value === null) return false;
	const { code, message } = value as { code?: unknown; message?: unknown };
	return typeof code === "string" && CODES.has(code) && typeof message === "string";
}

/** The same `Result` with a failure's message as plain text, for callers whose error channel is a string. */
export function textError<T>(result: Result<T, WardenError>): Result<T> {
	return result.success ? result : { success: false, error: result.error.message };
}

/** The same `Result` with a plain-text failure as a {@link WardenError} of `code`. */
export function codedError<T>(
	result: Result<T>,
	code: WardenErrorCode,
	extra: WardenErrorExtra = {}
): Result<T, WardenError> {
	return result.success ? result : wardenErr(code, result.error, extra);
}
