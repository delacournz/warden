import { type ProjectContext, type ProjectContextInput, projectContext } from "@delacour/warden-core/builds/ensure";
import type { AsyncResult } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";

/** `projectContext` with the command's exec, env and git cache, so the project lookup shares the git facts of the whole command. */
export function projectContextFor(
	ctx: CommandContext,
	input: Omit<ProjectContextInput, "exec" | "env" | "git">
): AsyncResult<ProjectContext> {
	return projectContext({ exec: ctx.exec, env: ctx.env, git: ctx.git, ...input });
}
