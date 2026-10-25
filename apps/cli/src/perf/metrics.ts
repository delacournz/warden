import type { Command as Commander } from "@commander-js/extra-typings";
import { parseDuration } from "@delacour/warden-perf/metrics/duration";
import {
	type MetricSample,
	memoryGrowthFinding,
	type SeriesSummary,
	type Stat,
	summarize,
} from "@delacour/warden-perf/metrics/series";
import { HARD_MAX_DURATION_MS } from "@delacour/warden-perf/shared/caps";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { ok, type Result } from "@delacour/warden-types/result";
import { UI_EXIT, type UiError, type UiSuccess, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import type { PerfTarget } from "./device";
import { appendSample, type MetricsOut, metricsOutFor } from "./metrics-out";
import { createSampler } from "./metrics-sampler";
import { buildFrame, createRedraw, defaultMetricsIo, type MetricsIo } from "./metrics-watch";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

export type PerfMetricsOptions = PerfOptionValues & { interval?: string; duration?: string; watch?: boolean };

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 200;
/** A one-shot reads the baseline plus a few CPU intervals: enough for a figure, short enough to be a probe. */
const DEFAULT_ONE_SHOT_MS = 3000;
const KB_PER_MB = 1024;

type Plan = { intervalMs: number; durationMs: number };

function plan(opts: PerfMetricsOptions): Result<Plan, UiError> {
	const interval = opts.interval === undefined ? DEFAULT_INTERVAL_MS : parseDuration(opts.interval);
	if (interval === undefined) {
		return {
			success: false,
			error: uiError("usage", `--interval must be a duration like 500ms or 2s, got "${opts.interval}"`),
		};
	}
	if (interval < MIN_INTERVAL_MS) {
		return {
			success: false,
			error: uiError("usage", `--interval must be at least ${MIN_INTERVAL_MS}ms: sampling faster skews the app`),
		};
	}
	const fallback = opts.watch === true ? HARD_MAX_DURATION_MS : DEFAULT_ONE_SHOT_MS;
	const duration = opts.duration === undefined ? fallback : parseDuration(opts.duration);
	if (duration === undefined) {
		return {
			success: false,
			error: uiError("usage", `--duration must be a duration like 10s or 1m, got "${opts.duration}"`),
		};
	}
	return ok({ intervalMs: interval, durationMs: Math.min(duration, HARD_MAX_DURATION_MS) });
}

export type SeriesResult = {
	samples: MetricSample[];
	aborted: boolean;
	/** why sampling ended early (the app went away) */
	stopped?: UiError;
};

const fixed = (n: number, digits = 1): string => n.toFixed(digits);

function statLine(label: string, stat: Stat, unit: string, scale = 1, digits = 1): string {
	const f = (n: number) => fixed(n / scale, digits);
	return `${label.padEnd(4)} min ${f(stat.min)}  avg ${f(stat.avg)}  p95 ${f(stat.p95)}  max ${f(stat.max)} ${unit}`;
}

/** The text report of a series: a header, a row per metric, the leak hint, where the samples went, `next:`. */
export function summaryLines(
	summary: SeriesSummary,
	finding: Finding | undefined,
	meta: { app: string; device: string; file: string; dim: (text: string) => string }
): string[] {
	const lines = [
		`${meta.app} on ${meta.device}: ${summary.count} sample${summary.count === 1 ? "" : "s"} over ${fixed(summary.durationMs / 1000)}s`,
	];
	if (summary.cpuPct) lines.push(statLine("cpu", summary.cpuPct, "%"));
	if (summary.pssKb) lines.push(statLine("pss", summary.pssKb, "MB", KB_PER_MB));
	lines.push(statLine("rss", summary.rssKb, "MB", KB_PER_MB));
	if (summary.fps) lines.push(statLine("fps", summary.fps, "fps"));
	if (summary.growth) {
		const g = summary.growth;
		const delta = (g.endKb - g.startKb) / KB_PER_MB;
		lines.push(`${g.metric} trend ${delta >= 0 ? "+" : ""}${fixed(delta)} MB (${fixed(g.slopeKbPerSec, 0)} KB/s)`);
	}
	if (finding) lines.push(`leak hint: ${finding.evidence}`);
	lines.push(meta.dim(`samples: ${meta.file}`));
	lines.push(
		meta.dim(`next: ${(finding?.next ?? ["warden perf memory --snapshot", "warden perf start --metrics"]).join(" · ")}`)
	);
	return lines;
}

/**
 * Sample every `intervalMs` until `durationMs` of the series have passed, Ctrl-C (`io.signal`), or the app goes
 * away. Each sample is appended to the file as it is taken and handed to `onSample` (the live display).
 */
async function runSeries(
	ctx: CommandContext,
	io: MetricsIo,
	sampler: { sample: () => Promise<Result<MetricSample, UiError>> },
	opts: {
		intervalMs: number;
		durationMs: number;
		startMs: number;
		file: string;
		onSample: (s: MetricSample, all: readonly MetricSample[]) => void;
	}
): Promise<SeriesResult> {
	const samples: MetricSample[] = [];
	const runStart = ctx.now();
	while (!io.signal.aborted) {
		const tickStart = ctx.now();
		const read = await sampler.sample();
		if (!read.success) return { samples, aborted: false, stopped: read.error };
		const fps = await io.fps?.({ atMs: read.data.atMs, wallMs: read.data.wallMs });
		const sample = fps === undefined ? read.data : { ...read.data, fps };
		samples.push(sample);
		appendSample(opts.file, sample);
		opts.onSample(sample, samples);
		if (ctx.now() - runStart >= opts.durationMs) break;
		await io.sleep(Math.max(0, opts.intervalMs - (ctx.now() - tickStart)), io.signal);
	}
	return { samples, aborted: io.signal.aborted };
}

function describeTarget(target: PerfTarget): string {
	return `${target.name ?? target.udid} (${target.platform})`;
}

/** Everything a finished series reports: the `UiSuccess` for `runPerf` (text, JSON result, warnings, exit 130 when interrupted). */
function seriesSuccess(
	ctx: CommandContext,
	target: PerfTarget,
	app: string,
	intervalMs: number,
	out: MetricsOut,
	series: SeriesResult
): Result<UiSuccess, UiError> {
	const summary = summarize(series.samples);
	if (summary === undefined) {
		return {
			success: false,
			error: series.stopped ?? uiError("interrupted", "interrupted before the first sample"),
		};
	}
	const finding = memoryGrowthFinding(summary);
	const device = describeTarget(target);
	return ok({
		device: {
			udid: target.udid,
			platform: target.platform,
			...(target.name !== undefined ? { name: target.name } : {}),
		},
		result: {
			app,
			intervalMs,
			summary,
			findings: finding ? [finding] : [],
			samples: out.file,
			...(out.sessionId !== undefined ? { sessionId: out.sessionId } : {}),
			...(series.aborted ? { interrupted: true } : {}),
		},
		text: summaryLines(summary, finding, { app, device, file: out.file, dim: ctx.ui.color.dim }).join("\n"),
		warnings: [
			"simulator/emulator numbers: compare relative, not absolute",
			...(series.stopped ? [`sampling stopped early: ${series.stopped.message}`] : []),
		],
		...(series.aborted ? { exit: UI_EXIT.interrupted } : {}),
	});
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
	const planned = plan(opts);
	if (!planned.success) return planned;
	const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
	if (!app.success) return app;
	const io =
		baseIo.fps === undefined && baseIo.fpsFor !== undefined
			? { ...baseIo, fps: baseIo.fpsFor(ctx, target, app.data.id) }
			: baseIo;
	const out = metricsOutFor(ctx, deps.session, target.udid);
	const sampler = await createSampler(
		ctx,
		{ udid: target.udid, platform: target.platform, app: app.data.id },
		out.startMs
	);
	if (!sampler.success) return sampler;

	const title = `${app.data.id} on ${describeTarget(target)}`;
	const redraw = display.live ? createRedraw(io, ctx.ui.columns, ctx.ui.color.dim) : undefined;
	const series = await runSeries(ctx, io, sampler.data, {
		...planned.data,
		startMs: out.startMs,
		file: out.file,
		onSample: (sample, all) => {
			if (redraw) redraw(buildFrame(title, all, io.fps !== undefined));
			else if (display.ndjson) ctx.out(JSON.stringify({ type: "sample", ...sample }));
		},
	});
	return seriesSuccess(ctx, target, app.data.id, planned.data.intervalMs, out, series);
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
