import type { Command as Commander } from "@commander-js/extra-typings";
import { perfFramesOps } from "@delacour/warden-sdk/ops/perf/frames";
import type { CommandContext } from "../context";
import { perfAppCli } from "./app";
import { perfOptionsCli } from "./options";
import { type PerfDeps, type PerfOptionValues, perfRunCli } from "./run";
export type PerfFramesOptions = PerfOptionValues & { reset?: boolean };

export class PerfFramesCli {
	/**
	 * `warden perf frames`: fps, janky %, dropped and frozen frames and the worst jank windows from
	 * `dumpsys gfxinfo framestats` (Android). A plain read is `observe`; `--reset` then clears the counters, which
	 * needs the caller's own lease (`mutate`). With an active session the windows are offsets from its start and carry
	 * the last mark; the report is also written to the session's `frames.json`.
	 */
	perfFrames(ctx: CommandContext, deps: PerfDeps, opts: PerfFramesOptions): Promise<number> {
		const reset = opts.reset === true;
		return perfRunCli.runPerf(ctx, deps, "frames", reset ? "mutate" : "observe", opts, async (target) => {
			const app = await perfAppCli.resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
			if (!app.success) return app;
			return perfFramesOps.framesWork(ctx, deps, target, app.data.id, reset);
		});
	}

	/** Wire `frames` onto `warden perf`. */
	readonly registerFrames = (
		cmd: Commander,
		ctx: CommandContext,
		done: (code: number) => void,
		deps: PerfDeps
	): void => {
		perfOptionsCli
			.withPerfOptions(
				cmd
					.command("frames")
					.description("fps, janky %, dropped/frozen frames and the worst jank windows (Android gfxinfo)")
					.option(
						"--reset",
						"clear the OS frame counters after reading so the next read is a fresh window (needs your lease)"
					)
			)
			.action(async (opts) => {
				done(await this.perfFrames(ctx, deps, opts));
			});
	};
}

export const perfFramesCli = new PerfFramesCli();
