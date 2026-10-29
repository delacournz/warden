#!/usr/bin/env bun
/**
 * Detached route ticker: `bun route-ticker.main.ts '<TickerConfig JSON>'` plays the route against one
 * emulator with `adb emu geo fix` until it finishes or gets SIGTERM/SIGINT. The spawner records this
 * process's pid as an `OwnedProcess` of the lease's location condition (see `detachedTickerArgv`).
 */
import { bunExec } from "@delacour/warden-core/exec";
import { geoFixArgv, geoFixFailure } from "../driver/android/android-argv";
import { parseTickerConfig, realTickerClock, startRouteTicker } from "./route-ticker";

const parsed = parseTickerConfig(process.argv[2] ?? "");
if (!parsed.success) {
	process.stderr.write(`route-ticker: ${parsed.error}\n`);
	process.exit(2);
}
const { adb, serial, ...route } = parsed.data;

const ticker = startRouteTicker(route, {
	...realTickerClock,
	fix: async (point) => {
		const res = await bunExec(geoFixArgv(adb, serial, point), { timeoutMs: 10_000 });
		return geoFixFailure(res);
	},
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => ticker.stop());

const outcome = await ticker.done;
if (outcome.stopped === "failed") {
	process.stderr.write(`route-ticker: ${outcome.error}\n`);
	process.exit(1);
}
process.exit(0);
