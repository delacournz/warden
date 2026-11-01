import type { Command as Commander } from "@commander-js/extra-typings";
import { perfSessionOps } from "@delacour/warden-sdk/ops/perf/session-ops";
import type { CommandContext } from "../context";
import { perfOptionsCli } from "./options";
import { type PerfDeps, type PerfOptionValues, perfRunCli } from "./run";

export class PerfMarkCli {
	/** `warden perf mark <label…>`: annotate the device's active session; commits, hangs and jank are tagged with the last mark before them. */
	perfMark(ctx: CommandContext, deps: PerfDeps, words: readonly string[], opts: PerfOptionValues): Promise<number> {
		return perfRunCli.runPerf(ctx, deps, "mark", "observe", opts, (target) =>
			perfSessionOps.markWork(ctx, deps, target, words.join(" "))
		);
	}

	/** Wire `mark` onto `warden perf`. */
	readonly registerMark = (cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void => {
		perfOptionsCli
			.withPerfOptions(
				cmd
					.command("mark")
					.description(
						"annotate the running session's timeline (commits, hangs and jank are tagged with the last mark)"
					)
					.argument("<label...>", "what is about to happen, e.g. scroll feed")
			)
			.action(async (label, opts) => {
				done(await this.perfMark(ctx, deps, label, opts));
			});
	};
}

export const perfMarkCli = new PerfMarkCli();
