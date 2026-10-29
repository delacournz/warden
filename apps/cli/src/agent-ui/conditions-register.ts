import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { withUiOptions } from "./ui-options";

/**
 * `warden ui net` and `warden ui location`: lease-scoped device conditions. One call from `commands/ui.ts`. Only the
 * commander wiring lives here; `conditions.ts` is imported by the subcommand that runs. (`network` is already the
 * devtools request log, hence `net`.)
 */
export function registerConditionCommands(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: UiDeps
): void {
	withUiOptions(
		cmd
			.command("net")
			.description(
				"change the device network: online | offline | edge | 3g | 4g | lte | wifi | slow | lossy, flap, fault, status, reset"
			)
			.argument("<action>", "a condition word, or flap | fault | status | reset")
			.argument("[args...]", "fault: <host-glob> <status:503|reset|delay:2s|blackhole>")
			.option("--latency <ms>", "added round-trip time (overrides the preset's)")
			.option("--jitter <n>", "ms of jitter on a condition; percent of phase length for flap")
			.option("--down <n>", "kbps down for a condition; how long the network is down for flap (10s)")
			.option("--up <n>", "kbps up for a condition; how long the network stays up for flap (3s)")
			.option("--loss <pct>", "packet loss, 0-100")
			.option("--seed <n>", "flap: same seed, same sequence (default 1)")
			.option(
				"--relaunch",
				"iOS: relaunch the app with the network dylib when it runs without (else E_NETWORK_RELAUNCH)"
			)
			.option("--clear", "fault: remove every fault")
	).action(async (action, args, opts) => {
		const { uiNet } = await import("./conditions");
		done(await uiNet(ctx, deps, action, args, opts));
	});
	withUiOptions(
		cmd
			.command("location")
			.description("simulate the device location: set | route | gpx | scenario | clear | status")
			.argument("<action>", "set <lat,lon> | route <lat,lon>... | gpx <file> | scenario <name> | clear | status")
			.argument("[args...]", "the points, file or scenario name")
			.option("--alt <m>", "set: altitude in metres")
			.option("--speed <m/s>", "route / gpx: speed (default 20)")
			.option("--interval <s>", "route: seconds between fixes (default 1)")
			.option("--loop", "route: start over at the end (Android; simctl cannot loop)")
	).action(async (action, args, opts) => {
		const { uiLocation } = await import("./conditions");
		done(await uiLocation(ctx, deps, action, args, opts));
	});
	withUiOptions(
		cmd
			.command("clock")
			.description("mock the device wall clock: set <iso> [--frozen] | advance <dur> | status | reset")
			.argument("<action>", "set <iso> | advance <dur> | status | reset")
			.argument("[args...]", "the time or duration")
			.option("--frozen", "set: hold the clock at that instant (iOS only; Android has no frozen clock)")
			.option(
				"--relaunch",
				"iOS: relaunch the app with the dylib when it runs without (else it applies from the next launch)"
			)
	).action(async (action, args, opts) => {
		const { uiClock } = await import("./conditions");
		done(await uiClock(ctx, deps, action, args, opts));
	});
}
