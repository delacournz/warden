import { processAlive } from "@warden/core/liveness";
import { readGitInfo } from "@warden/core/owner";
import { backgroundAllowed, maybeAutoGc, selfCommand, spawnDetached } from "../autogc";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { shutdownReleasedDevices } from "../device-shutdown";
import { deviceState } from "../device-state";
import { type HookDeps, type HookResult, handlePreToolUse, handleSessionEnd } from "../hooks/claude-pretool";
import { errorMessage } from "../hooks/json";

type HookKind = "pretool" | "session-end";

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

/**
 * Claude Code / Codex hook entry point. Only a live foreign lease exits 2; every warden failure exits 0.
 * Output is machine-read: no colour, spinners or prompts.
 */
async function hook(ctx: CommandContext, kind: HookKind): Promise<number> {
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

export const hookCommand = defineCommand({
	name: "hook",
	summary: "Claude Code hooks: lease argent devices per session; on session end shut down what it booted + release",
	register: (cmd, ctx, done) => {
		cmd
			.command("pretool")
			.description(
				"PreToolUse: lease the argent device a tool call targets (reads hook JSON on stdin; exit 2 = blocked)"
			)
			.action(async () => done(await hook(ctx, "pretool")));
		cmd
			.command("session-end")
			.description("SessionEnd: shut down what the session booted + release its leases (reads hook JSON on stdin)")
			.action(async () => done(await hook(ctx, "session-end")));
	},
});
