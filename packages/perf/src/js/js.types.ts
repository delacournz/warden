/** A failure of a JS profiling step. `unsupported` = this Hermes build does not implement the CDP method. */
export type JsErrorCode = "unsupported" | "cdp_failed" | "invalid_profile" | "invalid_snapshot" | "too_large";

export type JsError = { code: JsErrorCode; message: string; hint?: string };

export type JsResult<T> = { success: true; data: T } | { success: false; error: JsError };

export const jsOk = <T>(data: T): JsResult<T> => ({ success: true, data });

export function jsErr(code: JsErrorCode, message: string, hint?: string): JsResult<never> {
	return { success: false, error: { code, message, ...(hint === undefined ? {} : { hint }) } };
}

export type CdpFailure = { code: string; message: string };

/** The slice of a devtools session the JS capturers use (`DevtoolsSession` satisfies it). */
export type JsCdp = {
	send: (
		method: string,
		params?: Record<string, unknown>,
		options?: { timeoutMs?: number }
	) => Promise<{ success: true; data: unknown } | { success: false; error: CdpFailure }>;
	onCdp: (method: string, handler: (params: unknown) => void) => () => void;
};

const UNSUPPORTED = /not found|not supported|unsupported|unknown method|not implemented|wasn't found/i;

/** Hermes answers a domain/method it lacks with an error like "'Profiler.start' wasn't found". */
export function isUnsupported(failure: CdpFailure): boolean {
	return UNSUPPORTED.test(failure.message);
}

/** `Runtime.evaluate` by value through any `JsCdp`. */
export async function evaluateValue(cdp: JsCdp, expression: string): Promise<JsResult<unknown>> {
	const reply = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
	if (!reply.success) return jsErr("cdp_failed", reply.error.message);
	const data = reply.data;
	if (typeof data !== "object" || data === null) return jsOk(undefined);
	if ("exceptionDetails" in data && data.exceptionDetails) return jsErr("cdp_failed", `evaluate threw: ${expression}`);
	const result = "result" in data ? data.result : undefined;
	return jsOk(typeof result === "object" && result !== null && "value" in result ? result.value : undefined);
}

/** `__DEV__` in the app: true on a dev build, false on release, undefined when it cannot be read. */
export async function readDevFlag(cdp: JsCdp): Promise<boolean | undefined> {
	const value = await evaluateValue(cdp, "typeof __DEV__ === 'undefined' ? null : !!__DEV__");
	return value.success && typeof value.data === "boolean" ? value.data : undefined;
}

/** The device's `Date.now()`: the alignment anchor against host wall time. */
export async function readDeviceWallMs(cdp: JsCdp): Promise<number | undefined> {
	const value = await evaluateValue(cdp, "Date.now()");
	return value.success && typeof value.data === "number" ? value.data : undefined;
}
