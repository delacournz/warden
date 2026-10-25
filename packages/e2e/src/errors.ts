import type { ErrorResult } from "@delacour/warden-types/result";

export type E2eErrorCode =
	| "LOCATOR_NOT_FOUND"
	| "LOCATOR_AMBIGUOUS"
	| "INVALID_LOCATOR"
	| "ACTION_FAILED"
	| "TIMEOUT"
	| "NOT_ACTIONABLE"
	| "INVALID_ARGUMENT"
	| "SESSION"
	| "DRIVER"
	| "ASSERTION"
	| "PERF_BUDGET";

/** Plain shape of a spec error: what `e2eErr()` accepts and what a `Result` carries. */
export type E2eErrorShape = {
	code: E2eErrorCode;
	message: string;
	/** text render of the accessibility tree at the moment of failure, when the caller had one */
	screen?: string;
	/** number of candidates for `LOCATOR_AMBIGUOUS` */
	matches?: number;
};

/**
 * Every failure a spec can see (`screen`, `expect`, `test`, session), discriminated by `code`.
 * A thrown class so specs can `instanceof` it; `e2eErr()` wraps one in a failed `Result`.
 */
export class E2eError extends Error implements E2eErrorShape {
	readonly code: E2eErrorCode;
	readonly screen?: string;
	readonly matches?: number;

	constructor(code: E2eErrorCode, message: string, screen?: string, matches?: number) {
		super(message);
		this.name = "E2eError";
		this.code = code;
		if (screen !== undefined) this.screen = screen;
		if (matches !== undefined) this.matches = matches;
	}

	static from(shape: E2eErrorShape): E2eError {
		return shape instanceof E2eError ? shape : new E2eError(shape.code, shape.message, shape.screen, shape.matches);
	}
}

/** `err()` for results carrying an `E2eError`. */
export function e2eErr(error: E2eErrorShape): ErrorResult<E2eError> {
	return { success: false, error: E2eError.from(error) };
}

/** One line for logs and thrown messages: `CODE: message`. */
export function describeE2eError(error: E2eErrorShape): string {
	return `${error.code}: ${error.message}`;
}
