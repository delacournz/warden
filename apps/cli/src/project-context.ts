import { type ProjectContext, type ProjectContextInput, projectContextLoader } from "@delacour/warden-builds/ensure";
import type { AsyncResult } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";

/** `projectContextLoader.load` with the command's exec, env and git cache, so the project lookup shares the git facts of the whole command. */
export function projectContextFor(
	ctx: CommandContext,
	input: Omit<ProjectContextInput, "exec" | "env" | "git">
): AsyncResult<ProjectContext> {
	return projectContextLoader.load({ exec: ctx.exec, env: ctx.env, git: ctx.git, ...input });
}
