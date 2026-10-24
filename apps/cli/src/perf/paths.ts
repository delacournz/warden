import { isAbsolute, join, relative } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import type { CommandContext } from "../context";

/** `$WARDEN_HOME/perf`: one directory per `warden perf` session. */
export function perfRoot(ctx: Pick<CommandContext, "env">): string {
	return join(wardenHome(ctx.env), "perf");
}

/** `$WARDEN_HOME/perf/<id>`: session.json plus every artifact the session's capturers write. */
export function sessionDir(ctx: Pick<CommandContext, "env">, id: string): string {
	return join(perfRoot(ctx), id);
}

/** A path for people to read: relative when it sits inside the cwd, else absolute (never `../../..`). */
export function displayPath(ctx: Pick<CommandContext, "cwd">, path: string): string {
	const rel = relative(ctx.cwd, path);
	return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}
