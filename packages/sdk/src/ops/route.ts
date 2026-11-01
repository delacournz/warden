import { readRoute } from "@delacour/warden-devtools/route";
import { resultFactory } from "@delacour/warden-types/result";
import { devtoolsError, type MetroParams, withFacet } from "./devtools";
import { fail } from "./errors";
import type { OpOutcome, OpSession } from "./session";

/** The screen the app is on; `route` is `undefined` when no screen is focused yet. */
export type RouteResult = { route: string | undefined };

/**
 * `route`: the Expo Router key of the focused screen (`(tabs)/todos`), read from the app's React tree through the
 * dev client. `devtools_unavailable` for a release build or before a React root mounted.
 */
export async function route(session: OpSession, params: MetroParams = {}): OpOutcome<RouteResult> {
	const broker = params.metro === undefined ? session.devtools?.broker : undefined;
	const brokered = broker === undefined ? undefined : await broker.route();
	if (brokered !== undefined) {
		if (!brokered.success) return brokered;
		const found = brokered.data.route ?? undefined;
		return resultFactory.ok({ result: { route: found }, text: found ?? "unknown" });
	}
	return withFacet(session, params, async (facet) => {
		const found = await readRoute(facet, { timeoutMs: session.timeoutMs });
		if (!found.success) return fail(devtoolsError(found.error));
		return resultFactory.ok({ result: { route: found.data }, text: found.data ?? "unknown" });
	});
}
