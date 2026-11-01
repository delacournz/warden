import { isAbsolute, join, relative } from "node:path";
import { storeLocator } from "@delacour/warden-store/store";
import type { PerfEnv } from "./env";

/** PerfPaths: paths. */
export class PerfPaths {
	/** `$WARDEN_HOME/perf`: one directory per `warden perf` session. */
	perfRoot(ctx: Pick<PerfEnv, "env">): string {
		return join(storeLocator.wardenHome(ctx.env), "perf");
	}

	/** `$WARDEN_HOME/perf/<id>`: session.json plus every artifact the session's capturers write. */
	readonly sessionDir = (ctx: Pick<PerfEnv, "env">, id: string): string => {
		return join(this.perfRoot(ctx), id);
	};

	/** A path for people to read: relative when it sits inside the cwd, else absolute (never `../../..`). */
	displayPath(ctx: Pick<PerfEnv, "cwd">, path: string): string {
		const rel = relative(ctx.cwd, path);
		return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
	}
}

export const perfPaths = new PerfPaths();
