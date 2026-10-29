#!/usr/bin/env bun
/**
 * Detached condition scheduler: `bun scheduler.main.ts '<SchedulerConfig JSON>'` runs a network flap or a
 * timeline against one device until it finishes or gets SIGTERM/SIGINT (a flap puts its base back first). The
 * spawner records this process's pid as an `OwnedProcess` of the lease's network condition (see
 * `detachedSchedulerArgv`). Exit: 0 finished or stopped, 1 failed, 2 bad config or unsupported platform.
 */
import { openConditionSink } from "./condition-events";
import { realTickerClock } from "./route-ticker";
import { startFlap, startTimeline } from "./scheduler";
import { parseSchedulerConfig } from "./scheduler.config";
import { schedulerTargets } from "./scheduler.targets";

const parsed = parseSchedulerConfig(process.argv[2] ?? "");
if (!parsed.success) {
	process.stderr.write(`scheduler: ${parsed.error}\n`);
	process.exit(2);
}
const config = parsed.data;
const open = schedulerTargets[config.platform];
if (!open) {
	process.stderr.write(`scheduler: no detached target for ${config.platform}\n`);
	process.exit(2);
}

const { target, close } = open(config);
const deps = { ...realTickerClock, ...(config.events ? { sink: openConditionSink(config.events) } : {}) };
const scheduler =
	config.mode === "flap" ? startFlap(target, config.flap, deps) : startTimeline(target, config.steps, deps);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => scheduler.stop());

const outcome = await scheduler.done;
await close();
if (outcome.stopped === "failed") {
	process.stderr.write(`scheduler: ${outcome.error}\n`);
	process.exit(1);
}
process.exit(0);
