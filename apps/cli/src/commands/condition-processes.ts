import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

/** What the detached condition processes run (tests inject; the real ones are imported when the subcommand runs). */
export type ConditionProcessDeps = {
	netproxy?: (raw: string) => Promise<void>;
	routeTicker?: (raw: string) => Promise<number>;
	scheduler?: (raw: string) => Promise<number>;
};

/** The detached condition processes share their injectable entry points and the run-to-exit-code wrapper. */
abstract class ConditionProcessCommand extends CliCommand {
	override readonly hidden = true;

	constructor(protected readonly deps: ConditionProcessDeps = {}) {
		super();
	}

	protected readonly defaultNetproxy = async (raw: string): Promise<void> => {
		const { NetproxyMain } = await import("@delacour/warden-core/netproxy/netproxy.main");
		await new NetproxyMain().run(raw);
	};

	protected readonly defaultRouteTicker = async (raw: string): Promise<number> => {
		const { routeTickerMain } = await import("@delacour/warden-device/conditions/route-ticker.main");
		return routeTickerMain.run(raw);
	};

	protected readonly defaultScheduler = async (raw: string): Promise<number> => {
		const { schedulerMain } = await import("@delacour/warden-device/conditions/scheduler.main");
		return schedulerMain.run(raw);
	};

	protected async runToEnd(
		ctx: CommandContext,
		name: string,
		raw: string,
		run: (raw: string) => Promise<number>
	): Promise<number> {
		try {
			return await run(raw);
		} catch (error) {
			output.reportError(ctx, name, error instanceof Error ? error.message : String(error));
			return 1;
		}
	}
}

export class NetproxyCommand extends ConditionProcessCommand {
	override readonly name = "__netproxy";
	override readonly summary = "a lease's network shaping proxy, started by `warden ui net` (internal)";
	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd.argument("<args>", "the proxy arguments, as JSON").action(async (raw) => {
			try {
				await (this.deps.netproxy ?? this.defaultNetproxy)(raw);
			} catch (error) {
				output.reportError(ctx, "__netproxy", error instanceof Error ? error.message : String(error));
				done(1);
				return;
			}
			// the proxy ends the process itself on SIGTERM / shutdown
			await new Promise<never>(() => undefined);
		});
	}
}

export class RouteTickerCommand extends ConditionProcessCommand {
	override readonly name = "__route-ticker";
	override readonly summary = "the detached Android location route ticker (internal)";
	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd.argument("<config>", "the ticker config, as JSON").action(async (raw) => {
			done(await this.runToEnd(ctx, "__route-ticker", raw, this.deps.routeTicker ?? this.defaultRouteTicker));
		});
	}
}

export class SchedulerCommand extends ConditionProcessCommand {
	override readonly name = "__scheduler";
	override readonly summary = "the detached network flap / timeline scheduler (internal)";
	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd.argument("<config>", "the scheduler config, as JSON").action(async (raw) => {
			done(await this.runToEnd(ctx, "__scheduler", raw, this.deps.scheduler ?? this.defaultScheduler));
		});
	}
}

export const netproxyCommand = new NetproxyCommand().definition();
export const routeTickerCommand = new RouteTickerCommand().definition();
export const schedulerCommand = new SchedulerCommand().definition();
