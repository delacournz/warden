import type { ErrorResult } from "@delacour/warden-types/result";

/**
 * Errors the spec API (`screen`, `expect`, `test`) reports, discriminated by `code`. `screen` is the text render of
 * the accessibility tree at the moment of failure, when the caller had one.
 */
export type E2eError =
	| { code: "LOCATOR_NOT_FOUND"; message: string; screen?: string }
	| { code: "LOCATOR_AMBIGUOUS"; message: string; matches: number; screen?: string }
	| { code: "INVALID_LOCATOR"; message: string; screen?: string }
	| { code: "TIMEOUT"; message: string; screen?: string };

export type E2eErrorCode = E2eError["code"];

/** `err()` for results carrying an `E2eError`. */
export function e2eErr(error: E2eError): ErrorResult<E2eError> {
	return { success: false, error };
}

/** One line for logs and thrown messages: `CODE: message`. */
export function describeE2eError(error: E2eError): string {
	return `${error.code}: ${error.message}`;
}
