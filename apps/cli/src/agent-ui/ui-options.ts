import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";

/** Default per-command deadline when `--timeout` is not given. */
export const DEFAULT_UI_TIMEOUT_MS = 5000;

/**
 * Options every `warden ui` subcommand takes (the plan's "global" flags; commander needs them per subcommand).
 * Kept apart from `run.ts` so registering the subcommands (`--help`, dispatch) loads no device or lease code.
 */
export function withUiOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
	cmd: Commander<Args, Opts, Globals>
) {
	return cmd
		.option("--udid <udid>", "device udid (iOS) / serial (Android)")
		.option("--serial <serial>", "Android serial")
		.option("--lease <id>", "use the device behind this lease id")
		.option("--claim", "take over a stale/missing lease, or claim a device when none is held")
		.option("--platform <platform>", "platform for --claim with no device named: ios (default) | android")
		.option("--profile <slug>", "device profile for --claim with no device named")
		.option("--runtime <runtime>", "runtime for --claim with no device named")
		.option(
			"--force",
			"drive the device even while a live warden process (e2e, batch, run) holds your lease on it; your own warden dev device is shared without it"
		)
		.option("--timeout <ms>", `deadline in milliseconds (default ${DEFAULT_UI_TIMEOUT_MS})`)
		.option("--no-record", "don't append this step to a running recording")
		.option("--json", "machine-readable output: one JSON document on stdout");
}
