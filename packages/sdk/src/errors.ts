import type { WardenError as EngineError } from "@delacour/warden-types/error";
import type { Dispatched, WardenErrorCode, WardenErrorShape } from "./sdk.types";

/**
 * Codes raised before (or instead of) any call that could reach the device: argument problems, lease and device
 * ownership checks, an engine that is missing, configuration and build failures, and a stale ref or missing target
 * (the op reads the screen first and refuses to act). A call that fails with one of these changed nothing on the
 * device, so repeating it is safe.
 */
const NOT_DISPATCHED: ReadonlySet<WardenErrorCode> = new Set<WardenErrorCode>([
	"usage",
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
	"device_not_leased",
	"no_device_leased",
	"ambiguous_device",
	"lease_not_found",
	"engine_unavailable",
	"devtools_unavailable",
	"stale_ref",
	"claim_aborted",
	"capacity_exhausted",
	"not_found",
	"build_failed",
	"config_invalid",
	"store_incompatible",
	"duplicate_provider",
	"no_recording",
	"recording_active",
	"target_exists",
	"empty_recording",
	"device_unknown",
	"app_not_found",
	"unsupported",
	"tool_missing",
]);

/** Codes that report work already done on the device when they fail. None today: a failure is `no` or `unknown`. */
const DISPATCHED: ReadonlySet<WardenErrorCode> = new Set<WardenErrorCode>();

/** Failures that go away by themselves: the caller may try the same call again later. */
const RETRYABLE: ReadonlySet<WardenErrorCode> = new Set<WardenErrorCode>([
	"device_busy",
	"capacity_exhausted",
	"probe_timeout",
	"timeout",
	"stale_ref",
]);

/**
 * The error every SDK call throws. Internals return `Result`s; the facade unwraps them once and throws this, so a
 * TypeScript caller can `catch` and branch on `code`, `retryable` and `dispatched`.
 */
export class WardenError extends Error implements WardenErrorShape {
	readonly code: WardenErrorCode;
	readonly hint: string | undefined;
	readonly details: Record<string, unknown> | undefined;
	readonly retryable: boolean | undefined;
	readonly dispatched: Dispatched;

	constructor(shape: Omit<WardenErrorShape, "dispatched"> & { dispatched?: Dispatched; cause?: unknown }) {
		super(shape.message, shape.cause === undefined ? undefined : { cause: shape.cause });
		this.name = "WardenError";
		this.code = shape.code;
		this.hint = shape.hint;
		this.details = shape.details;
		this.retryable = shape.retryable ?? (RETRYABLE.has(shape.code) ? true : undefined);
		this.dispatched = shape.dispatched ?? sdkErrors.dispatchedFor(shape.code);
	}

	/** The plain JSON shape (what `JSON.stringify(error)` also yields). */
	toJSON(): WardenErrorShape {
		return {
			code: this.code,
			message: this.message,
			...(this.hint !== undefined ? { hint: this.hint } : {}),
			...(this.details !== undefined ? { details: this.details } : {}),
			...(this.retryable !== undefined ? { retryable: this.retryable } : {}),
			dispatched: this.dispatched,
		};
	}
}

/** Narrow a caught value to a {@link WardenError}. */
export function isWardenError(value: unknown): value is WardenError {
	return value instanceof WardenError;
}

/** Builders for {@link WardenError}: classify a code, wrap an engine error or a thrown value. */
export class SdkErrors {
	/**
	 * Whether a failure with `code` may have reached the device. Rule: `no` when the code is one the engine raises
	 * before it calls the driver or runs a process (see {@link NOT_DISPATCHED}); `yes` when part of the work is known
	 * to have run ({@link DISPATCHED}); `unknown` for everything else (`failed`, `timeout`, `interrupted`,
	 * `probe_timeout`, `lease_*`): the call may have been in flight when it failed.
	 */
	dispatchedFor(code: WardenErrorCode): Dispatched {
		if (NOT_DISPATCHED.has(code)) return "no";
		return DISPATCHED.has(code) ? "yes" : "unknown";
	}

	/** An engine error as the thrown class. */
	toWardenError(error: EngineError, dispatched?: Dispatched): WardenError {
		return new WardenError({
			code: error.code,
			message: error.message,
			...(error.hint !== undefined ? { hint: error.hint } : {}),
			...(error.details !== undefined ? { details: error.details } : {}),
			...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
			...(dispatched !== undefined ? { dispatched } : {}),
		});
	}

	/** A thrown-for-any-reason value (a rejected sleep, a bug) as a {@link WardenError}: `interrupted` when `signal` aborted. */
	fromThrown(error: unknown, signal?: AbortSignal): WardenError {
		if (isWardenError(error)) return error;
		if (signal?.aborted) {
			return new WardenError({
				code: "interrupted",
				message: "aborted",
				cause: error,
				hint: "the AbortSignal passed to this call fired",
			});
		}
		return new WardenError({
			code: "failed",
			message: error instanceof Error ? error.message : String(error),
			cause: error,
		});
	}

	/** The error for a call that finds its signal already aborted. */
	interrupted(): WardenError {
		return new WardenError({
			code: "interrupted",
			message: "aborted",
			hint: "the AbortSignal passed to this call fired",
			dispatched: "no",
		});
	}
}

export const sdkErrors = new SdkErrors();
