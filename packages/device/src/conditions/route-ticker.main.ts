#!/usr/bin/env bun
import { realTickerClock, routeTickers } from "@delacour/warden-driver/conditions/route-ticker";
import { androidArgv } from "@delacour/warden-driver-android/android-argv";
/**
 * Detached route ticker: `bun route-ticker.main.ts '<TickerConfig JSON>'` plays the route against one
 * emulator with `adb emu geo fix` until it finishes or gets SIGTERM/SIGINT. The spawner records this
 * process's pid as an `OwnedProcess` of the lease's location condition (see `detachedTickerArgv`).
 * A compiled `warden` runs the same loop as its hidden `__route-ticker` subcommand (`routeTickerMain.run`).
 */
import { processExec } from "@delacour/warden-runtime/exec";

export class RouteTickerMain {
	/** Play the route in `raw` (a `TickerConfig` JSON). Exit code: 0 finished or stopped, 1 a fix kept failing, 2 bad config. */
	async run(raw: string): Promise<number> {
		const parsed = routeTickers.parseConfig(raw);
		if (!parsed.success) {
			process.stderr.write(`route-ticker: ${parsed.error}\n`);
			return 2;
		}
		const { adb, serial, ...route } = parsed.data;

		const ticker = routeTickers.start(route, {
			...realTickerClock,
			fix: async (point) => {
				const res = await processExec.run(androidArgv.geoFixArgv(adb, serial, point), { timeoutMs: 10_000 });
				return androidArgv.geoFixFailure(res);
			},
		});
		for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => ticker.stop());

		const outcome = await ticker.done;
		if (outcome.stopped === "failed") {
			process.stderr.write(`route-ticker: ${outcome.error}\n`);
			return 1;
		}
		return 0;
	}
}

export const routeTickerMain = new RouteTickerMain();

if (import.meta.main) {
	routeTickerMain.run(process.argv[2] ?? "").then((code) => process.exit(code));
}
