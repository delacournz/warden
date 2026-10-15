export type E2eErrorCode =
	| "LOCATOR_NOT_FOUND"
	| "LOCATOR_AMBIGUOUS"
	| "ACTION_FAILED"
	| "TIMEOUT"
	| "NOT_ACTIONABLE"
	| "INVALID_ARGUMENT"
	| "SESSION"
	| "DRIVER"
	| "ASSERTION";

/** Every failure a spec can see; `screen` is an excerpt of the rendered screen when one helps. */
export class E2eError extends Error {
	readonly code: E2eErrorCode;
	readonly screen?: string;

	constructor(code: E2eErrorCode, message: string, screen?: string) {
		super(message);
		this.name = "E2eError";
		this.code = code;
		if (screen !== undefined) this.screen = screen;
	}
}
