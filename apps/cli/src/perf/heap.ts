import type { Command as Commander } from "@commander-js/extra-typings";
import { perfHeap } from "@delacour/warden-sdk/ops/perf/heap";
import { defaultJsDeps, type JsDeps } from "@delacour/warden-sdk/ops/perf/js-capture";
import { uiOutput } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { output } from "../output";
import { resolveApp } from "./app";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

export type PerfHeapSnapshotOptions = PerfOptionValues & { metro?: string };

/**
 * `warden perf heap snapshot`: a Hermes heap snapshot of the running dev client, streamed to
 * `js/heap-<ts>.heapsnapshot` (opens in Chrome DevTools, Memory tab) with the top 15 constructors by self size and
 * count. Mutating: the snapshot freezes the JS thread while it is taken, so it needs the caller's lease on the
 * device. Retained sizes are not computed here; open the file for them.
 */
export function perfHeapSnapshot(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfHeapSnapshotOptions,
	js: JsDeps = defaultJsDeps
): Promise<number> {
	return runPerf(ctx, deps, "heap snapshot", "mutate", opts, async (target, env) => {
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		return perfHeap.heapSnapshotWork(ctx, deps, js, target, app.data.id, opts.metro, env.timeoutMs);
	});
}

export type PerfHeapDiffOptions = { json?: boolean };

/** `warden perf heap diff <a> <b>`: constructor count and self-size deltas from snapshot `a` (before) to `b` (after). Reads files only. */
export function perfHeapDiff(ctx: CommandContext, a: string, b: string, opts: PerfHeapDiffOptions): number {
	const json = opts.json === true;
	const report = { command: "perf heap diff", label: "perf heap diff", json, startedAt: ctx.now() };
	const diff = perfHeap.heapDiffWork(ctx, a, b);
	if (!diff.success) return uiOutput.reportError(ctx, report, diff.error);
	output.emit(ctx, json, diff.data.result, diff.data.text, { scope: "perf heap diff" });
	return 0;
}

/** Wire `heap snapshot` and `heap diff` onto `warden perf`. */
export function registerHeap(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	const heap = cmd.command("heap").description("Hermes heap snapshots: take one, diff two");
	withPerfOptions(
		heap
			.command("snapshot")
			.description(
				"heap snapshot of the dev client (js/heap-<ts>.heapsnapshot) with the top constructors; needs your lease"
			)
			.option("--metro <url>", "Metro to attach through (default: the one serving the device)")
	).action(async (opts) => {
		done(await perfHeapSnapshot(ctx, deps, opts));
	});
	heap
		.command("diff")
		.description("constructor count and size deltas between two .heapsnapshot files")
		.argument("<before>", "earlier snapshot")
		.argument("<after>", "later snapshot")
		.option("--json", "machine-readable output")
		.action((before, after, opts) => {
			done(perfHeapDiff(ctx, before, after, opts));
		});
}
