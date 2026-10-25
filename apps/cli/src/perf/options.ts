import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { withUiOptions } from "../agent-ui/ui-options";

/**
 * Options every device-bound `warden perf` subcommand takes: the `warden ui` device flags plus `--app` and
 * `--allow-mutate-foreign` (commander keeps parent options positional, so each subcommand repeats them).
 */
export function withPerfOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
	cmd: Commander<Args, Opts, Globals>
) {
	return withUiOptions(cmd)
		.option("--app <id>", "bundle id (iOS) / package (Android); default: the foreground app, then warden.config")
		.option(
			"--allow-mutate-foreign",
			"let a mutating step act on a device someone else holds (refused while a live warden process holds it)"
		);
}
