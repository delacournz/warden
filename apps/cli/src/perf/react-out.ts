import { join } from "node:path";
import { formatSessionId } from "@delacour/warden-perf/shared/session.schema";
import type { CommandContext } from "../context";
import { JS_DIR } from "./js-capture";
import { perfRoot, sessionDir } from "./paths";
import { activeSessionFor, type SessionDeps } from "./session";

export const REACT_DIR = "react";
export const COMMITS_FILE = "commits.json";
export const FINDINGS_FILE = "findings.json";

/** Where React artifacts go: `<dir>/commits.json` and `findings.json`; `jsDir` = the session's JS profile, to correlate. */
export type ReactOut = { dir: string; jsDir?: string; sessionId?: string; startMs: number };

/**
 * The `react/` directory a hand-run `perf react` writes to. With a session running on the device it is that
 * session's (and its `js/` dir feeds the CPU correlation); otherwise a one-shot dir under `$WARDEN_HOME/perf`
 * (its name is not a session id, so session listing and sweeping ignore it).
 */
export function reactOutFor(ctx: CommandContext, deps: SessionDeps, udid: string): ReactOut {
	const session = activeSessionFor(ctx, deps, udid);
	if (session !== undefined) {
		const root = sessionDir(ctx, session.id);
		return {
			dir: join(root, REACT_DIR),
			jsDir: join(root, JS_DIR),
			sessionId: session.id,
			startMs: session.startedAt.wallMs,
		};
	}
	const now = ctx.now();
	return { dir: join(perfRoot(ctx), `react-${formatSessionId(now, deps.random())}`, REACT_DIR), startMs: now };
}
