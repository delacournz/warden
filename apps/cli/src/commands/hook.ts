import { processAlive } from "@delacour/warden-core/liveness";
import { backgroundAllowed, selfCommand, spawnDetached } from "../autogc";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { shutdownReleasedDevices } from "../device-shutdown";
import { diskGateEnabled, readDiskState } from "../disk-deps";
import { type HookDeps, type HookResult, handleSessionEnd } from "../hooks/claude-pretool";
import { errorMessage } from "../hooks/json";
import { handleSessionStart } from "../hooks/session-start";

function hookDeps(ctx: CommandContext): HookDeps {
	return {
		store: ctx.store,
		now: ctx.now,
		pidAlive: processAlive,
		shutdown: (leases, owner) => shutdownReleasedDevices(ctx, leases, owner),
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

/** Longest the SessionStart hook waits for the hook JSON on stdin: its content is not used. */
const STDIN_WAIT_MS = 300;

/**
 * SessionStart: one line for the agent when the disk or swap is under pressure, else nothing. Exits 0 always;
 * the verdict is cached in the store for a minute.
 */
async function sessionStart(ctx: CommandContext): Promise<number> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			ctx.readStdin(),
			new Promise((resolve) => {
				timer = setTimeout(resolve, STDIN_WAIT_MS);
			}),
		]);
	} catch {
		// the hook JSON is not needed
	} finally {
		clearTimeout(timer);
	}
	const line = await handleSessionStart({
		store: ctx.store,
		now: ctx.now,
		enabled: diskGateEnabled(ctx.env),
		readDisk: () => readDiskState(ctx),
	});
	if (line) ctx.out(line);
	return 0;
}

export const hookCommand = defineCommand({
	name: "hook",
	group: "Setup",
	summary:
		"Claude Code / Codex hooks: on session start hint at low disk or high swap; on session end shut down what the session booted + release its leases",
	register: (cmd, ctx, done) => {
		cmd
			.command("pretool", { hidden: true })
			.description("No-op, kept so a PreToolUse hook installed by an older warden keeps working")
			.action(() => done(0));
		cmd
			.command("session-start")
			.description(
				"SessionStart: print one line when the disk or swap is under pressure, else nothing (always exits 0)"
			)
			.action(async () => done(await sessionStart(ctx)));
		cmd
			.command("session-end")
			.description("SessionEnd: shut down what the session booted + release its leases (reads hook JSON on stdin)")
			.action(async () => done(await hook(ctx)));
	},
});
