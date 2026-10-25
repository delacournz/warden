import { readRoute } from "@delacour/warden-e2e/devtools/route";
import { ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDevice } from "./device";
import { devtoolsDeps, withFacet } from "./devtools-cli";
import type { UiDeps } from "./driver";
import { uiError } from "./output";
import type { UiRunEnv } from "./run";
import { type RecordingPointer, readState, updateState } from "./state";

/** One read is one Metro lookup, one socket and one evaluate: a slow or absent app must not slow the action down. */
export const ROUTE_TIMEOUT_MS = 1_500;

/** Consecutive failed reads after which a recording stops trying (a release build never answers). */
export const MAX_ROUTE_MISSES = 3;

type Routes = NonNullable<RecordingPointer["routes"]>;

function remember(ctx: CommandContext, udid: string, next: (routes: Routes) => Routes): void {
	updateState(ctx, udid, (current) =>
		current.recording
			? { ...current, recording: { ...current.recording, routes: next(current.recording.routes ?? {}) } }
			: current
	);
}

/**
 * The route the app is on now (Expo Router key, dev client only), read through the devtools bridge. `undefined` for
 * "unknown", never an error. The state keeps the last route and the failures in a row, so a read that finds the same
 * route as before answers nothing new (the journal records a route only when it changed).
 */
export async function readCurrentRoute(
	ctx: CommandContext,
	deps: UiDeps,
	env: UiRunEnv,
	device: UiDevice
): Promise<string | undefined> {
	const routes = readState(ctx, device.udid).recording?.routes;
	if ((routes?.misses ?? 0) >= MAX_ROUTE_MISSES) return undefined;
	const miss = (): undefined => {
		remember(ctx, device.udid, (current) => ({ ...current, misses: (current.misses ?? 0) + 1 }));
		return undefined;
	};
	try {
		const read = await withFacet(
			ctx,
			devtoolsDeps(deps),
			device,
			{ ...env, timeoutMs: ROUTE_TIMEOUT_MS },
			{},
			async (facet) => {
				const found = await readRoute(facet, { timeoutMs: ROUTE_TIMEOUT_MS });
				return found.success ? ok(found.data) : { success: false, error: uiError("failed", found.error.message) };
			}
		);
		if (!read.success) return miss();
		remember(ctx, device.udid, (current) => ({ ...current, misses: 0 }));
		return read.data;
	} catch {
		return miss();
	}
}

/** The route after an action, only when it differs from the last one seen; remembers it. */
export async function captureRoute(
	ctx: CommandContext,
	deps: UiDeps,
	env: UiRunEnv,
	device: UiDevice
): Promise<string | undefined> {
	const route = await readCurrentRoute(ctx, deps, env, device);
	if (route === undefined) return undefined;
	if (readState(ctx, device.udid).recording?.routes?.last === route) return undefined;
	remember(ctx, device.udid, (current) => ({ ...current, last: route }));
	return route;
}

/** At `record start`: the route the app is on before the first step, so the screen the journey begins on counts as visited. */
export async function startRoute(ctx: CommandContext, deps: UiDeps, env: UiRunEnv, device: UiDevice): Promise<void> {
	const route = await readCurrentRoute(ctx, deps, env, device);
	if (route !== undefined) remember(ctx, device.udid, (current) => ({ ...current, initial: route, last: route }));
}
