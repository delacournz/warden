import { appendFileSync } from "node:fs";
import { processAlive } from "@warden/core/liveness";
import { readGitInfo } from "@warden/core/owner";
import type { Command, CommandContext } from "../context";
import {
	type HookDeps,
	type HookResult,
	handlePreToolUse,
	handleSessionEnd,
	handleSessionStart,
} from "../hooks/claude-pretool";
import { errorMessage } from "../hooks/json";

const USAGE = "warden hook pretool|session-start|session-end   (reads Claude Code hook JSON on stdin)";

type HookKind = "pretool" | "session-start" | "session-end";

function isHookKind(value: string | undefined): value is HookKind {
	return value === "pretool" || value === "session-start" || value === "session-end";
}

function hookDeps(ctx: CommandContext): HookDeps {
	return { store: ctx.store, now: ctx.now, pidAlive: processAlive, gitInfo: readGitInfo };
}

function dispatch(ctx: CommandContext, kind: HookKind, input: unknown): HookResult {
	switch (kind) {
		case "pretool":
			return handlePreToolUse(input, hookDeps(ctx));
		case "session-end":
			return handleSessionEnd(input, hookDeps(ctx));
		case "session-start": {
			const envFile = ctx.env.CLAUDE_ENV_FILE;
			return handleSessionStart(input, {
				...(envFile ? { envFile } : {}),
				appendFile: (path, text) => appendFileSync(path, text),
			});
		}
	}
}

/** Claude Code hook entry point. Only a live foreign lease exits 2; every warden failure exits 0. */
async function run(ctx: CommandContext): Promise<number> {
	const kind = ctx.argv[0];
	if (!isHookKind(kind)) {
		ctx.err(`warden hook: expected pretool|session-start|session-end\n${USAGE}`);
		return 1;
	}
	let input: unknown;
	try {
		input = JSON.parse(await ctx.readStdin());
	} catch (error) {
		ctx.err(`warden hook ${kind}: bad stdin JSON (${errorMessage(error)}) — allowing`);
		return 0;
	}
	const result = dispatch(ctx, kind, input);
	if (result.stdout) ctx.out(result.stdout);
	if (result.stderr) ctx.err(result.stderr);
	return result.exitCode;
}

export const hookCommand: Command = {
	name: "hook",
	summary: "Claude Code hooks: lease argent devices per session, release on session end",
	usage: USAGE,
	run,
};
