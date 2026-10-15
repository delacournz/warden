import type { Result } from "@delacour/warden-types/result";

/** Why a devtools call failed. `devtools_unavailable` = no dev client to talk to (release build, no Metro, no target). */
export type DevtoolsErrorCode =
	| "devtools_unavailable"
	| "device_mismatch"
	| "cdp_closed"
	| "cdp_timeout"
	| "cdp_protocol"
	| "binding_unavailable"
	| "eval_failed";

export type DevtoolsError = { code: DevtoolsErrorCode; message: string };

export type DevtoolsResult<T> = Result<T, DevtoolsError>;

/** The `Runtime.exceptionDetails` object of a failed `Runtime.evaluate`. */
export type ExceptionDetails = {
	text?: string;
	lineNumber?: number;
	columnNumber?: number;
	url?: string;
	exception?: { type?: string; subtype?: string; className?: string; description?: string; value?: unknown };
};

/** Failure of `DevtoolsSession.evaluate`: a thrown JS exception carries `exceptionDetails`. */
export type EvaluateError = { message: string; code?: DevtoolsErrorCode; exceptionDetails?: ExceptionDetails };

/** The slice of `Response` the devtools code reads; the global `fetch` satisfies it. */
export type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };

/** Injectable `fetch` (the global one is assignable). */
export type Fetch = (input: string, init?: { method?: string; signal?: AbortSignal }) => Promise<FetchResponse>;

export type Sleep = (ms: number) => Promise<void>;

export function devtoolsErr(code: DevtoolsErrorCode, message: string): { success: false; error: DevtoolsError } {
	return { success: false, error: { code, message } };
}
