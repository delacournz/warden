import type { ConsoleLine } from "@delacour/warden-e2e/devtools/devtools.types";

/** React Native's error path: a thrown error reaches the console as `console.error` from these frames. */
const RN_REPORTERS = new Set(["reportException", "handleException"]);

/**
 * An uncaught exception as the app sees it: a CDP `exceptionThrown`, or (in a dev build, where React Native catches
 * it first) the `console.error` that `ExceptionsManager.reportException` writes for it. Type-only imports: the
 * `warden ui exceptions` fallback loads this without the broker.
 */
export function isAppException(line: ConsoleLine): boolean {
	if (line.kind === "exception") return true;
	return line.level === "error" && (line.stack ?? []).some((frame) => RN_REPORTERS.has(frame.fn ?? ""));
}
