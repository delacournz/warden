import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";

/** What `__ios-runner-restart` reaches the outside world through; tests inject both. */
export type IosRunnerRestartDeps = {
	stop?: (ctx: CommandContext, udid: string) => Promise<{ warning?: string }>;
	ensure?: (ctx: CommandContext, udid: string) => Promise<{ success: true } | { success: false; error: string }>;
};

/** exit code when the runner host cannot be started again (the `warden ui` engine code) */
const EXIT_ENGINE = 3;

async function restart(ctx: CommandContext, deps: IosRunnerRestartDeps, udid: string | undefined): Promise<number> {
	if (udid === undefined) {
		reportError(ctx, "__ios-runner-restart", "--udid is required");
		return 1;
	}
	const stop =
		deps.stop ??
		(async (c, id) => {
			const { stopIosRunner } = await import("../agent-ui/helper");
			return stopIosRunner(c, id);
		});
	const ensure =
		deps.ensure ??
		(async (c, id) => {
			const { ensureIosRunner } = await import("../agent-ui/helper");
			const host = await ensureIosRunner(c, id);
			return host.success ? { success: true as const } : { success: false as const, error: host.error.message };
		});
	const stopped = await stop(ctx, udid);
	if (stopped.warning !== undefined) ctx.err(`warden __ios-runner-restart: ${stopped.warning}`);
	const started = await ensure(ctx, udid);
	if (!started.success) {
		reportError(ctx, "__ios-runner-restart", started.error);
		return EXIT_ENGINE;
	}
	return 0;
}

/**
 * `warden __ios-runner-restart --udid <udid>`: stop a physical iPhone's runner host and start a new one on the same
 * socket, waiting until it answers. `warden e2e` hands it to the spec session (`WARDEN_IOS_RUNNER_RESTART`), which runs
 * it once when the runner connection is lost. It never reboots the phone. Exit 0 restarted · 1 bad arguments · 3 the
 * host did not come back.
 */
export function createIosRunnerRestartCommand(deps: IosRunnerRestartDeps = {}) {
	return defineCommand({
		name: "__ios-runner-restart",
		summary: "restart an iPhone's runner host for a running e2e session (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd.option("--udid <udid>").action(async (opts) => done(await restart(ctx, deps, opts.udid)));
		},
	});
}

export const iosRunnerRestartCommand = createIosRunnerRestartCommand();
