import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { uiOptionsHelper } from "../agent-ui/ui-options";

export class PerfOptionsCli {
	/**
	 * Options every device-bound `warden perf` subcommand takes: the `warden ui` device flags plus `--app` and
	 * `--allow-mutate-foreign` (commander keeps parent options positional, so each subcommand repeats them).
	 */
	withPerfOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
		cmd: Commander<Args, Opts, Globals>
	) {
		return uiOptionsHelper
			.withDeviceOptions(cmd)
			.option("--app <id>", "bundle id (iOS) / package (Android); default: the foreground app, then warden.config")
			.option(
				"--allow-mutate-foreign",
				"let a mutating step act on a device someone else holds (refused while a live warden process holds it)"
			);
	}
}

export const perfOptionsCli = new PerfOptionsCli();
