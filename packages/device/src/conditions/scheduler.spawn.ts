import { join } from "node:path";
import type { OwnedProcess } from "@delacour/warden-config/conditions.types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { routeTickerSpawner, type SpawnTicker } from "./route-ticker.spawn";
import { type SchedulerConfig, schedulerConfigs } from "./scheduler.config";

/** Starts a network flap or timeline scheduler as its own process. */
export class SchedulerSpawner {
	/**
	 * Start a flap or timeline as its own process that outlives this one (a `warden ui` call is short-lived).
	 * Returns the handle to pass as `owned` to `recordCondition(store, leaseId, "network", value, now, [owned])`
	 * so release/gc undo kills it. When replacing a schedule, kill the previous handle first.
	 */
	detached(
		config: SchedulerConfig,
		spawn: SpawnTicker = routeTickerSpawner.bunSpawnDetached,
		runtime: string = process.execPath,
		mainPath: string = join(import.meta.dir, "scheduler.main.ts")
	): Result<OwnedProcess> {
		const started = spawn(schedulerConfigs.detachedArgv(runtime, mainPath, config));
		return started
			? resultFactory.ok({ kind: "pid", pid: started.pid })
			: resultFactory.err("could not start the condition scheduler");
	}

	/**
	 * Like {@link SchedulerSpawner.detached}, for a compiled `warden` that has no script to hand `bun`: runs
	 * `[...command, <config JSON>]` (`command` = the binary and its hidden `__scheduler` subcommand).
	 */
	via(
		config: SchedulerConfig,
		command: readonly string[],
		spawn: SpawnTicker = routeTickerSpawner.bunSpawnDetached
	): Result<OwnedProcess> {
		const started = spawn([...command, JSON.stringify(config)]);
		return started
			? resultFactory.ok({ kind: "pid", pid: started.pid })
			: resultFactory.err("could not start the condition scheduler");
	}
}

export const schedulerSpawner = new SchedulerSpawner();
