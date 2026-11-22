import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * What the `warden-runner` (XCUITest) wire adds to the `warden-simd` protocol of `simd-protocol.ts` (the shared
 * schemas and `SimdClient` are reused unchanged): the `appState` op, and the facts about the runner the driver acts on.
 * The runner's own contract is `native/ios-runner/AGENTS.md`.
 */

/**
 * How a runner session's token reaches the runner: `xcodebuild` forwards `TEST_RUNNER_<NAME>` to the UI-test process
 * as `<NAME>`. Always through the environment of the `xcodebuild` process, never its command line.
 */
export const RUNNER_TOKEN_ENV = "TEST_RUNNER_WARDEN_RUNNER_TOKEN";

/** A token for one runner session: 32 random bytes, hex. Made by whoever starts the runner and kept in that process. */
export function newRunnerToken(): string {
	return randomBytes(32).toString("hex");
}

/**
 * The first line of every TCP connection to the runner. The runner answers it with its `ready` event; it sends
 * nothing before it and closes a connection whose first line is anything else.
 */
export function runnerAuthLine(token: string): string {
	return `${JSON.stringify({ op: "auth", token })}\n`;
}

export const appStateSchema = z.enum([
	"notRunning",
	"runningBackgroundSuspended",
	"runningBackground",
	"runningForeground",
	"unknown",
]);
export type AppState = z.infer<typeof appStateSchema>;

export const appStateDataSchema = z.looseObject({ state: z.string() });

/** `appState` reply data, or undefined when it is not shaped like one. */
export function parseAppState(data: unknown): AppState | undefined {
	const parsed = appStateDataSchema.safeParse(data);
	if (!parsed.success) return undefined;
	const known = appStateSchema.safeParse(parsed.data.state);
	return known.success ? known.data : "unknown";
}

/** The app is alive in some form (a suspended background app still has its process). */
export function isRunning(state: AppState): boolean {
	return state === "runningForeground" || state === "runningBackground" || state === "runningBackgroundSuspended";
}
