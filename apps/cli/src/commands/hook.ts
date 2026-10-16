import { processAlive } from "@delacour/warden-core/liveness";
import { stopHelperAfterOnDemand } from "../agent-ui/helper-after";
import { backgroundAllowed, selfCommand, spawnDetached } from "../autogc";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { shutdownReleasedDevices } from "../device-shutdown";
import { type HookDeps, type HookResult, handleSessionEnd } from "../hooks/claude-pretool";
import { errorMessage } from "../hooks/json";

function hookDeps(ctx: CommandContext): HookDeps {
	return {
		store: ctx.store,
		now: ctx.now,
		pidAlive: processAlive,
		shutdown: (leases, owner) => shutdownReleasedDevices(ctx, leases, owner),
		stopHelper: stopHelperAfterOnDemand(ctx),
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

function dispatch(ctx: CommandContext, input: unknown): Promise<HookResult> {
	return handleSessionEnd(input, hookDeps(ctx));
}

/**
 * Claude Code / Codex hook entry point. Only a live foreign lease exits 2; every warden failure exits 0.
 * Output is machine-read: no colour, spinners or prompts.
 */
async function hook(ctx: CommandContext): Promise<number> {
	let input: unknown;
	try {
		input = JSON.parse(await ctx.readStdin());
	} catch (error) {
		ctx.err(`warden hook session-end: bad stdin JSON (${errorMessage(error)}) — allowing`);
		return 0;
	}
	const result = await dispatch(ctx, input);
	if (result.stdout) ctx.out(result.stdout);
	if (result.stderr) ctx.err(result.stderr);
	return result.exitCode;
}

export const hookCommand = defineCommand({
	name: "hook",
	group: "Setup",
	summary: "Claude Code / Codex hook: on session end shut down what the session booted + release its leases",
	register: (cmd, ctx, done) => {
		cmd
			.command("pretool", { hidden: true })
			.description("No-op, kept so a PreToolUse hook installed by an older warden keeps working")
			.action(() => done(0));
		cmd
			.command("session-end")
			.description("SessionEnd: shut down what the session booted + release its leases (reads hook JSON on stdin)")
			.action(async () => done(await hook(ctx)));
	},
});
