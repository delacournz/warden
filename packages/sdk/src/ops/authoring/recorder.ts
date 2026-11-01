import type { RecordSink } from "../record";
import type { OpSession } from "../session";
import type { StateStore } from "../state-store";
import type { JournalSinkInit } from "./sink";

/** Actions that can change the screen the app shows; only these are worth a route read. */
const NAVIGATING: ReadonlySet<string> = new Set(["press", "tap", "open", "back", "key", "alert", "use"]);

/**
 * The recorder an op session appends finished actions to. Nothing is loaded or written when no recording is active,
 * so an ordinary action never imports the journal code.
 */
export function journalRecorder(init: JournalSinkInit): RecordSink {
	return {
		append: async (udid, step) => {
			if (!init.state.read().recording) return;
			const { journalSink } = await import("./sink");
			await journalSink(init).append(udid, step);
		},
	};
}

/**
 * The route the app moved to after `action`, when a recording is active and the action can navigate. Best effort: any
 * failure (release build, no Metro, slow app) is no route, never an error. `session` is only asked once a read is due,
 * so a caller can build it lazily.
 */
export function routeAfterFor(
	state: StateStore,
	session: () => OpSession | Promise<OpSession>
): (action: string) => Promise<string | undefined> {
	return async (action) => {
		if (!NAVIGATING.has(action) || !state.read().recording) return undefined;
		const { captureRoute } = await import("./route");
		return captureRoute(await session());
	};
}
