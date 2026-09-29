import { processAlive } from "@warden/core/liveness";
import { readGitInfo } from "@warden/core/owner";
import { backgroundAllowed, maybeAutoGc, selfCommand, spawnDetached } from "../autogc";
import type { Command, CommandContext } from "../context";
import { shutdownReleasedDevices } from "../device-shutdown";
import { deviceState } from "../device-state";
import { type HookDeps, type HookResult, handlePreToolUse, handleSessionEnd } from "../hooks/claude-pretool";
import { errorMessage } from "../hooks/json";

const USAGE = "warden hook pretool|session-end   (reads Claude Code hook JSON on stdin)";

type HookKind = "pretool" | "session-end";

function isHookKind(value: string | undefined): value is HookKind {
	return value === "pretool" || value === "session-end";
}

function hookDeps(ctx: CommandContext): HookDeps {
	return {
		store: ctx.store,
		now: ctx.now,
		pidAlive: processAlive,
		gitInfo: readGitInfo,
		deviceState: (platform, id) => deviceState(ctx.exec, ctx.env, platform, id),
		shutdown: (leases, owner) => shutdownReleasedDevices(ctx, leases, owner),
		maybeGc: () => maybeAutoGc(ctx),
		endInBackground: (sessionId) => {
			if (!backgroundAllowed(ctx.env)) return false;
			spawnDetached([...selfCommand(), "release", "--session", sessionId, "--shutdown"], {
				...process.env,
				...ctx.env,
			});
			return true;
		},
	};
}

function dispatch(ctx: CommandContext, kind: HookKind, input: unknown): Promise<HookResult> {
	switch (kind) {
		case "pretool":
			return handlePreToolUse(input, hookDeps(ctx));
		case "session-end":
			return handleSessionEnd(input, hookDeps(ctx));
	}
}

/** Claude Code hook entry point. Only a live foreign lease exits 2; every warden failure exits 0. */
async function run(ctx: CommandContext): Promise<number> {
	const kind = ctx.argv[0];
	if (!isHookKind(kind)) {
		ctx.err(`warden hook: expected pretool|session-end\n${USAGE}`);
		return 1;
	}
	let input: unknown;
	try {
		input = JSON.parse(await ctx.readStdin());
	} catch (error) {
		ctx.err(`warden hook ${kind}: bad stdin JSON (${errorMessage(error)}) — allowing`);
		return 0;
	}
	const result = await dispatch(ctx, kind, input);
	if (result.stdout) ctx.out(result.stdout);
	if (result.stderr) ctx.err(result.stderr);
	return result.exitCode;
}

export const hookCommand: Command = {
	name: "hook",
	summary: "Claude Code hooks: lease argent devices per session; on session end shut down what it booted + release",
	usage: USAGE,
	run,
};
