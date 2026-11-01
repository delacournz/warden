import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

/** What `__ios-runner-restart` reaches the outside world through; tests inject both. */
export type IosRunnerRestartDeps = {
	stop?: (ctx: CommandContext, udid: string) => Promise<{ warning?: string }>;
	ensure?: (ctx: CommandContext, udid: string) => Promise<{ success: true } | { success: false; error: string }>;
};

/** exit code when the runner host cannot be started again (the `warden ui` engine code) */
const EXIT_ENGINE = 3;

export class IosRunnerRestartCommand extends CliCommand {
	override readonly name = "__ios-runner-restart";
	override readonly summary = "restart an iPhone's runner host for a running e2e session (internal)";
	override readonly hidden = true;

	constructor(private readonly deps: IosRunnerRestartDeps = {}) {
		super();
	}

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd.option("--udid <udid>").action(async (opts) => done(await this.restart(ctx, this.deps, opts.udid)));
	}

	private async restart(ctx: CommandContext, deps: IosRunnerRestartDeps, udid: string | undefined): Promise<number> {
		if (udid === undefined) {
			output.reportError(ctx, "__ios-runner-restart", "--udid is required");
			return 1;
		}
		const stop =
			deps.stop ??
			(async (c, id) => {
				const { uiHelper } = await import("../agent-ui/helper");
				return uiHelper.stopIosRunner(c, id);
			});
		const ensure =
			deps.ensure ??
			(async (c, id) => {
				const { uiHelper } = await import("../agent-ui/helper");
				const host = await uiHelper.ensureIosRunner(c, id);
				return host.success ? { success: true as const } : { success: false as const, error: host.error.message };
			});
		const stopped = await stop(ctx, udid);
		if (stopped.warning !== undefined) ctx.err(`warden __ios-runner-restart: ${stopped.warning}`);
		const started = await ensure(ctx, udid);
		if (!started.success) {
			output.reportError(ctx, "__ios-runner-restart", started.error);
			return EXIT_ENGINE;
		}
		return 0;
	}
}

export const iosRunnerRestartCommand = new IosRunnerRestartCommand().definition();
