import type { Command as Commander } from "@commander-js/extra-typings";
import { type MetricsParams, metricsSeries, planSeries } from "@delacour/warden-sdk/ops/perf/metrics";
import type { Result } from "@delacour/warden-types/result";
import type { UiError, UiSuccess } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import type { PerfTarget } from "./device";
import { buildFrame, createRedraw, defaultMetricsIo, type MetricsIo } from "./metrics-watch";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";
export type PerfMetricsOptions = PerfOptionValues & MetricsParams;

function describeTarget(target: PerfTarget): string {
	return `${target.name ?? target.udid} (${target.platform})`;
}

/** How a run shows its samples as they arrive: sparklines on stderr (`live`), NDJSON on stdout (`ndjson`), or not at all. */
type Display = { live: boolean; ndjson: boolean };

async function metricsWork(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfMetricsOptions,
	baseIo: MetricsIo,
	display: Display,
	target: PerfTarget
): Promise<Result<UiSuccess, UiError>> {
	const planned = planSeries(opts);
	if (!planned.success) return planned;
	const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
	if (!app.success) return app;
	const io =
		baseIo.fps === undefined && baseIo.fpsFor !== undefined
			? { ...baseIo, fps: baseIo.fpsFor(ctx, target, app.data.id) }
			: baseIo;
	const title = `${app.data.id} on ${describeTarget(target)}`;
	const redraw = display.live ? createRedraw(io, ctx.ui.columns, ctx.ui.color.dim) : undefined;
	return metricsSeries(ctx, deps, target, app.data.id, planned.data, io, (sample, all) => {
		if (redraw) redraw(buildFrame(title, all, io.fps !== undefined));
		else if (display.ndjson) ctx.out(JSON.stringify({ type: "sample", ...sample }));
	});
}

/**
 * `warden perf metrics [--interval 1s] [--duration 10s] [--watch]`: CPU % and memory of the app as a time
 * series. Observe-only: never leases the device. Samples land in the running session's `metrics/samples.jsonl`,
 * else a one-shot dir under `$WARDEN_HOME/perf`. `--watch` redraws sparklines on stderr (a TTY) or streams one
 * NDJSON line per sample on stdout (piped, or `--json`); Ctrl-C ends it with the summary and exit 130.
 */
export function perfMetrics(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfMetricsOptions,
	io: MetricsIo = defaultMetricsIo()
): Promise<number> {
	const watch = opts.watch === true;
	const live = watch && ctx.ui.rich && opts.json !== true;
	const display: Display = { live, ndjson: watch && !live };
	const effective: PerfMetricsOptions = display.ndjson ? { ...opts, json: true as const } : opts;
	return runPerf(ctx, deps, "metrics", "observe", effective, (target) =>
		metricsWork(ctx, deps, opts, io, display, target)
	).finally(() => io.dispose?.());
}

/** Wire `metrics` onto `warden perf`. */
export function registerMetrics(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("metrics")
			.description(
				"CPU % and memory of the app over time (min/avg/p95/max, memory growth); --watch draws live sparklines"
			)
			.option("--interval <duration>", "time between samples (min 200ms)", "1s")
			.option("--duration <duration>", "how long to sample (default 3s; with --watch until Ctrl-C, max 5m)")
			.option(
				"--watch",
				"redraw sparklines on stderr (NDJSON on stdout when piped or --json); Ctrl-C prints the summary, exit 130"
			)
	).action(async (opts) => {
		done(await perfMetrics(ctx, deps, opts));
	});
}
