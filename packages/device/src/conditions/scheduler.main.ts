#!/usr/bin/env bun
/**
 * Detached condition scheduler: `bun scheduler.main.ts '<SchedulerConfig JSON>'` runs a network flap or a
 * timeline against one device until it finishes or gets SIGTERM/SIGINT (a flap puts its base back first). The
 * spawner records this process's pid as an `OwnedProcess` of the lease's network condition (see
 * `SchedulerConfigs.detachedArgv`). A compiled `warden` runs the same loop as its hidden `__scheduler` subcommand
 * (`schedulerMain.run`). Exit: 0 finished or stopped, 1 failed, 2 bad config or unsupported platform.
 */
import { conditionEvents } from "@delacour/warden-driver/conditions/condition-events";
import { realTickerClock } from "@delacour/warden-driver/conditions/route-ticker";
import { schedulers } from "@delacour/warden-driver/conditions/scheduler";
import { schedulerConfigs } from "./scheduler.config";
import { schedulerTargets } from "./scheduler.targets";

export class SchedulerMain {
	/** Run the schedule in `raw` (a `SchedulerConfig` JSON) to its end. */
	async run(raw: string): Promise<number> {
		const parsed = schedulerConfigs.parse(raw);
		if (!parsed.success) {
			process.stderr.write(`scheduler: ${parsed.error}\n`);
			return 2;
		}
		const config = parsed.data;
		const open = schedulerTargets.opener(config.platform);
		if (!open) {
			process.stderr.write(`scheduler: no detached target for ${config.platform}\n`);
			return 2;
		}

		const { target, close } = open(config);
		const deps = { ...realTickerClock, ...(config.events ? { sink: conditionEvents.openSink(config.events) } : {}) };
		const scheduler =
			config.mode === "flap"
				? schedulers.startFlap(target, config.flap, deps)
				: schedulers.startTimeline(target, config.steps, deps);
		for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => scheduler.stop());

		const outcome = await scheduler.done;
		await close();
		if (outcome.stopped === "failed") {
			process.stderr.write(`scheduler: ${outcome.error}\n`);
			return 1;
		}
		return 0;
	}
}

export const schedulerMain = new SchedulerMain();

if (import.meta.main) {
	schedulerMain.run(process.argv[2] ?? "").then((code) => process.exit(code));
}
