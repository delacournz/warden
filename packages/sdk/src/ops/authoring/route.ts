import { routeReader } from "@delacour/warden-devtools/route";
import { resultFactory } from "@delacour/warden-types/result";
import { devtoolsError, withFacet } from "../devtools";
import type { OpSession } from "../session";
import type { RecordingPointer } from "./pointer";

/** One read is one Metro lookup, one socket and one evaluate: a slow or absent app must not slow the action down. */
export const ROUTE_TIMEOUT_MS = 1_500;

/** Consecutive failed reads after which a recording stops trying (a release build never answers). */
export const MAX_ROUTE_MISSES = 3;

type Routes = NonNullable<RecordingPointer["routes"]>;

function remember(session: OpSession, next: (routes: Routes) => Routes): void {
	session.state.update((current) =>
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
export async function readCurrentRoute(session: OpSession): Promise<string | undefined> {
	const routes = session.state.read().recording?.routes;
	if ((routes?.misses ?? 0) >= MAX_ROUTE_MISSES) return undefined;
	const miss = (): undefined => {
		remember(session, (current) => ({ ...current, misses: (current.misses ?? 0) + 1 }));
		return undefined;
	};
	try {
		const quick = { ...session, timeoutMs: ROUTE_TIMEOUT_MS };
		const read = await withFacet(quick, {}, async (facet) => {
			const found = await routeReader.read(facet, { timeoutMs: ROUTE_TIMEOUT_MS });
			return found.success ? resultFactory.ok(found.data) : { success: false, error: devtoolsError(found.error) };
		});
		if (!read.success) return miss();
		remember(session, (current) => ({ ...current, misses: 0 }));
		return read.data;
	} catch {
		return miss();
	}
}

/** The route after an action, only when it differs from the last one seen; remembers it. */
export async function captureRoute(session: OpSession): Promise<string | undefined> {
	const route = await readCurrentRoute(session);
	if (route === undefined) return undefined;
	if (session.state.read().recording?.routes?.last === route) return undefined;
	remember(session, (current) => ({ ...current, last: route }));
	return route;
}

/** At `record start`: the route the app is on before the first step, so the screen the journey begins on counts as visited. */
export async function startRoute(session: OpSession): Promise<void> {
	const route = await readCurrentRoute(session);
	if (route !== undefined) remember(session, (current) => ({ ...current, initial: route, last: route }));
}
