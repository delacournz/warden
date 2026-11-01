import { join } from "node:path";
import type { OwnedProcess } from "@delacour/warden-config/conditions.types";
import { routeTickers, type TickerConfig } from "@delacour/warden-driver/conditions/route-ticker";
import { type Result, resultFactory } from "@delacour/warden-types/result";

export type SpawnTicker = (argv: readonly string[]) => { pid: number } | undefined;

const bunSpawnDetached: SpawnTicker = (argv) => {
	const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
	proc.unref();
	return { pid: proc.pid };
};

/**
 * Start the route ticker as its own process that outlives this one (a `warden ui` call is short-lived).
 * Returns the handle to pass as `owned` to `recordCondition(store, leaseId, "location", value, now, [owned])`
 * so release/gc undo kills it. When replacing a route, kill the previous handle first.
 */
export function spawnDetachedTicker(
	config: TickerConfig,
	spawn: SpawnTicker = bunSpawnDetached,
	runtime: string = process.execPath,
	mainPath: string = join(import.meta.dir, "route-ticker.main.ts")
): Result<OwnedProcess> {
	const started = spawn(routeTickers.detachedArgv(runtime, mainPath, config));
	return started
		? resultFactory.ok({ kind: "pid", pid: started.pid })
		: resultFactory.err("could not start the route ticker");
}

/**
 * Like {@link spawnDetachedTicker}, for a compiled `warden` that has no script to hand `bun`: runs
 * `[...command, <config JSON>]` (`command` = the binary and its hidden `__route-ticker` subcommand).
 */
export function spawnDetachedTickerVia(
	config: TickerConfig,
	command: readonly string[],
	spawn: SpawnTicker = bunSpawnDetached
): Result<OwnedProcess> {
	const started = spawn([...command, JSON.stringify(config)]);
	return started
		? resultFactory.ok({ kind: "pid", pid: started.pid })
		: resultFactory.err("could not start the route ticker");
}
