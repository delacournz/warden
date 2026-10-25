import { join } from "node:path";
import { formatSessionId } from "@delacour/warden-perf/shared/session.schema";
import type { CommandContext } from "../context";
import { JS_DIR } from "./js-capture";
import { perfRoot, sessionDir } from "./paths";
import { activeSessionFor, type SessionDeps } from "./session";

/** Where JS artifacts go: `<dir>/js/…`, timed from `startMs`. */
export type JsOut = { dir: string; startMs: number; sessionId?: string; jsCapturing: boolean };

/**
 * The `js/` directory a hand-run `perf js` / `perf heap` writes to. With a session running on the device it is that
 * session's; otherwise a one-shot dir under `$WARDEN_HOME/perf` (its name is not a session id, so session listing
 * and sweeping ignore it). `jsCapturing` = the session's collector already holds the Hermes profiler.
 */
export function jsOutFor(ctx: CommandContext, deps: SessionDeps, udid: string, prefix: "js" | "heap"): JsOut {
	const session = activeSessionFor(ctx, deps, udid);
	if (session !== undefined) {
		return {
			dir: join(sessionDir(ctx, session.id), JS_DIR),
			startMs: session.startedAt.wallMs,
			sessionId: session.id,
			jsCapturing: session.capturers.some((c) => c.kind === "js" && c.state === "running"),
		};
	}
	const now = ctx.now();
	return {
		dir: join(perfRoot(ctx), `${prefix}-${formatSessionId(now, deps.random())}`, JS_DIR),
		startMs: now,
		jsCapturing: false,
	};
}
