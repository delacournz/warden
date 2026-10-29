import { join } from "node:path";
import type { OwnedProcess } from "@delacour/warden-core/conditions/conditions.types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { detachedTickerArgv, type TickerConfig } from "./route-ticker";

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
	const started = spawn(detachedTickerArgv(runtime, mainPath, config));
	return started ? ok({ kind: "pid", pid: started.pid }) : err("could not start the route ticker");
}
