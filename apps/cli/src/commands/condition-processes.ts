import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";

/** What the detached condition processes run (tests inject; the real ones are imported when the subcommand runs). */
export type ConditionProcessDeps = {
	netproxy?: (raw: string) => Promise<void>;
	routeTicker?: (raw: string) => Promise<number>;
	scheduler?: (raw: string) => Promise<number>;
};

async function defaultNetproxy(raw: string): Promise<void> {
	const { runNetproxy } = await import("@delacour/warden-core/netproxy/netproxy.main");
	await runNetproxy(raw);
}

async function defaultRouteTicker(raw: string): Promise<number> {
	const { runRouteTicker } = await import("@delacour/warden-e2e/conditions/route-ticker.main");
	return runRouteTicker(raw);
}

async function defaultScheduler(raw: string): Promise<number> {
	const { runScheduler } = await import("@delacour/warden-e2e/conditions/scheduler.main");
	return runScheduler(raw);
}

/**
 * `warden __netproxy '<json>'`: a lease's shaping proxy (`LeaseProxyDeps.command`). Listens, writes its handle file
 * and stays until SIGTERM / `POST /shutdown` (the proxy exits the process itself). Exit 1 on a bad argument.
 */
export function createNetproxyCommand(deps: ConditionProcessDeps = {}) {
	return defineCommand({
		name: "__netproxy",
		summary: "a lease's network shaping proxy, started by `warden ui net` (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd.argument("<args>", "the proxy arguments, as JSON").action(async (raw) => {
				try {
					await (deps.netproxy ?? defaultNetproxy)(raw);
				} catch (error) {
					reportError(ctx, "__netproxy", error instanceof Error ? error.message : String(error));
					done(1);
					return;
				}
				// the proxy ends the process itself on SIGTERM / shutdown
				await new Promise<never>(() => undefined);
			});
		},
	});
}

async function runToEnd(
	ctx: CommandContext,
	name: string,
	raw: string,
	run: (raw: string) => Promise<number>
): Promise<number> {
	try {
		return await run(raw);
	} catch (error) {
		reportError(ctx, name, error instanceof Error ? error.message : String(error));
		return 1;
	}
}

/**
 * `warden __route-ticker '<json>'`: the detached Android route ticker of `warden ui location route`. Plays the route
 * until it ends or SIGTERM. Exit 0 finished or stopped · 1 a fix kept failing · 2 bad config.
 */
export function createRouteTickerCommand(deps: ConditionProcessDeps = {}) {
	return defineCommand({
		name: "__route-ticker",
		summary: "the detached Android location route ticker (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd.argument("<config>", "the ticker config, as JSON").action(async (raw) => {
				done(await runToEnd(ctx, "__route-ticker", raw, deps.routeTicker ?? defaultRouteTicker));
			});
		},
	});
}

/**
 * `warden __scheduler '<json>'`: the detached network flap / timeline of `warden ui net flap`. Runs until it ends or
 * SIGTERM (a flap puts its base back first). Exit 0 finished or stopped · 1 failed · 2 bad config.
 */
export function createSchedulerCommand(deps: ConditionProcessDeps = {}) {
	return defineCommand({
		name: "__scheduler",
		summary: "the detached network flap / timeline scheduler (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd.argument("<config>", "the scheduler config, as JSON").action(async (raw) => {
				done(await runToEnd(ctx, "__scheduler", raw, deps.scheduler ?? defaultScheduler));
			});
		},
	});
}

export const netproxyCommand = createNetproxyCommand();
export const routeTickerCommand = createRouteTickerCommand();
export const schedulerCommand = createSchedulerCommand();
