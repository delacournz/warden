#!/usr/bin/env bun
/**
 * Detached condition scheduler: `bun scheduler.main.ts '<SchedulerConfig JSON>'` runs a network flap or a
 * timeline against one device until it finishes or gets SIGTERM/SIGINT (a flap puts its base back first). The
 * spawner records this process's pid as an `OwnedProcess` of the lease's network condition (see
 * `detachedSchedulerArgv`). A compiled `warden` runs the same loop as its hidden `__scheduler` subcommand
 * (`runScheduler`). Exit: 0 finished or stopped, 1 failed, 2 bad config or unsupported platform.
 */
import { openConditionSink } from "./condition-events";
import { realTickerClock } from "./route-ticker";
import { startFlap, startTimeline } from "./scheduler";
import { parseSchedulerConfig } from "./scheduler.config";
import { schedulerTargets } from "./scheduler.targets";

/** Run the schedule in `raw` (a `SchedulerConfig` JSON) to its end. */
export async function runScheduler(raw: string): Promise<number> {
	const parsed = parseSchedulerConfig(raw);
	if (!parsed.success) {
		process.stderr.write(`scheduler: ${parsed.error}\n`);
		return 2;
	}
	const config = parsed.data;
	const open = schedulerTargets[config.platform];
	if (!open) {
		process.stderr.write(`scheduler: no detached target for ${config.platform}\n`);
		return 2;
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
		return 1;
	}
	return 0;
}

if (import.meta.main) {
	runScheduler(process.argv[2] ?? "").then((code) => process.exit(code));
}
