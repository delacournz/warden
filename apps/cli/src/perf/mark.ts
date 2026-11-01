import type { Command as Commander } from "@commander-js/extra-typings";
import { perfSessionOps } from "@delacour/warden-sdk/ops/perf/session-ops";
import type { CommandContext } from "../context";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

/** `warden perf mark <label…>`: annotate the device's active session; commits, hangs and jank are tagged with the last mark before them. */
export function perfMark(
	ctx: CommandContext,
	deps: PerfDeps,
	words: readonly string[],
	opts: PerfOptionValues
): Promise<number> {
	return runPerf(ctx, deps, "mark", "observe", opts, (target) =>
		perfSessionOps.markWork(ctx, deps, target, words.join(" "))
	);
}

/** Wire `mark` onto `warden perf`. */
export function registerMark(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	withPerfOptions(
		cmd
			.command("mark")
			.description("annotate the running session's timeline (commits, hangs and jank are tagged with the last mark)")
			.argument("<label...>", "what is about to happen, e.g. scroll feed")
	).action(async (label, opts) => {
		done(await perfMark(ctx, deps, label, opts));
	});
}
