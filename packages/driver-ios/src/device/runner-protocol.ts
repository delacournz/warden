import { z } from "zod";

/**
 * What the `warden-runner` (XCUITest) wire adds to the `warden-simd` protocol of `simd-protocol.ts` (the shared
 * schemas and `SimdClient` are reused unchanged): the `appState` op, and the facts about the runner the driver acts on.
 * The runner's own contract is `native/ios-runner/AGENTS.md`.
 */

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
