import { ReleasedDeviceShutdown } from "@delacour/warden-leasing/device-shutdown";
import { liveness } from "@delacour/warden-store/liveness";
import { autoGc } from "../autogc";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { type HookDeps, type HookResult, hookClaudePretool } from "../hooks/claude-pretool";
import { hookJson } from "../hooks/json";
import { leaseHostBuilder } from "../lease-host";

export class HookCommand extends CliCommand {
	override readonly name = "hook";
	override readonly group = "Setup";
	override readonly summary =
		"Claude Code / Codex hook: on session end shut down what the session booted + release its leases";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.command("pretool", { hidden: true })
			.description("No-op, kept so a PreToolUse hook installed by an older warden keeps working")
			.action(() => done(0));
		cmd
			.command("session-end")
			.description("SessionEnd: shut down what the session booted + release its leases (reads hook JSON on stdin)")
			.action(async () => done(await this.hook(ctx)));
	}

	private hookDeps(ctx: CommandContext): HookDeps {
		return {
			store: ctx.store,
			now: ctx.now,
			pidAlive: liveness.processAlive,
			shutdown: (leases, owner) =>
				new ReleasedDeviceShutdown(leaseHostBuilder.leaseHostFromContext(ctx)).run(leases, owner),
			endInBackground: (sessionId) => {
				if (!autoGc.backgroundAllowed(ctx.env)) return false;
				autoGc.spawnDetached([...autoGc.selfCommand(), "release", "--session", sessionId, "--shutdown"], {
					...process.env,
					...ctx.env,
				});
				return true;
			},
		};
	}

	private dispatch(ctx: CommandContext, input: unknown): Promise<HookResult> {
		return hookClaudePretool.handleSessionEnd(input, this.hookDeps(ctx));
	}

	/**
	 * Claude Code / Codex hook entry point. Only a live foreign lease exits 2; every warden failure exits 0.
	 * Output is machine-read: no colour, spinners or prompts.
	 */
	private async hook(ctx: CommandContext): Promise<number> {
		let input: unknown;
		try {
			input = JSON.parse(await ctx.readStdin());
		} catch (error) {
			ctx.err(`warden hook session-end: bad stdin JSON (${hookJson.errorMessage(error)}) — allowing`);
			return 0;
		}
		const result = await this.dispatch(ctx, input);
		if (result.stdout) ctx.out(result.stdout);
		if (result.stderr) ctx.err(result.stderr);
		return result.exitCode;
	}
}

export const hookCommand = new HookCommand().definition();
