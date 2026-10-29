import { join } from "node:path";
import type { OwnedProcess } from "@delacour/warden-core/conditions/conditions.types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { SpawnTicker } from "./route-ticker.spawn";
import { detachedSchedulerArgv, type SchedulerConfig } from "./scheduler.config";

const bunSpawnDetached: SpawnTicker = (argv) => {
	const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
	proc.unref();
	return { pid: proc.pid };
};

/**
 * Start a flap or timeline as its own process that outlives this one (a `warden ui` call is short-lived).
 * Returns the handle to pass as `owned` to `recordCondition(store, leaseId, "network", value, now, [owned])`
 * so release/gc undo kills it. When replacing a schedule, kill the previous handle first.
 */
export function spawnDetachedScheduler(
	config: SchedulerConfig,
	spawn: SpawnTicker = bunSpawnDetached,
	runtime: string = process.execPath,
	mainPath: string = join(import.meta.dir, "scheduler.main.ts")
): Result<OwnedProcess> {
	const started = spawn(detachedSchedulerArgv(runtime, mainPath, config));
	return started ? ok({ kind: "pid", pid: started.pid }) : err("could not start the condition scheduler");
}

/**
 * Like {@link spawnDetachedScheduler}, for a compiled `warden` that has no script to hand `bun`: runs
 * `[...command, <config JSON>]` (`command` = the binary and its hidden `__scheduler` subcommand).
 */
export function spawnDetachedSchedulerVia(
	config: SchedulerConfig,
	command: readonly string[],
	spawn: SpawnTicker = bunSpawnDetached
): Result<OwnedProcess> {
	const started = spawn([...command, JSON.stringify(config)]);
	return started ? ok({ kind: "pid", pid: started.pid }) : err("could not start the condition scheduler");
}
