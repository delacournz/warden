import type { Command as Commander } from "@commander-js/extra-typings";
import { type MemoryIo, perfMemoryOps, realMemoryIo } from "@delacour/warden-sdk/ops/perf/memory";
import { metricsOutPaths } from "@delacour/warden-sdk/ops/perf/metrics-out";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";
export type PerfMemoryOptions = PerfOptionValues & { snapshot?: boolean };

/**
 * `warden perf memory [--snapshot]`: where the app's memory sits right now. Plain: Android `dumpsys meminfo`
 * (TOTAL PSS/RSS, top categories) or iOS `vmmap --summary` (footprint, top regions), observe-only. `--snapshot`
 * pauses the app to capture a heap (iOS `leaks --outputGraph` memgraph + leak summary, Android `am dumpheap`
 * .hprof pulled then removed from the device), so it needs the caller's own lease.
 */
export function perfMemory(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfMemoryOptions,
	io: MemoryIo = realMemoryIo
): Promise<number> {
	const snapshot = opts.snapshot === true;
	return runPerf(ctx, deps, "memory", snapshot ? "mutate" : "observe", opts, async (target) => {
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		const out = metricsOutPaths.artifactDirFor(ctx, deps.session, target.udid);
		return perfMemoryOps.memoryWork(ctx, target, app.data.id, snapshot, out.dir, io);
	});
}

/** Wire `memory` onto `warden perf`. */
export function registerMemory(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("memory")
			.description(
				"memory breakdown of the app; --snapshot captures a heap (iOS memgraph + leaks, Android .hprof), pausing the app"
			)
			.option("--snapshot", "capture a heap snapshot into the session dir (needs your own lease: --claim)")
	).action(async (opts) => {
		done(await perfMemory(ctx, deps, opts));
	});
}
