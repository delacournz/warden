import { perfDuration } from "@delacour/warden-perf/metrics/duration";
import { type MetricSample, type SeriesSummary, type Stat, sampleSeries } from "@delacour/warden-perf/metrics/series";
import { HARD_MAX_DURATION_MS } from "@delacour/warden-perf/shared/caps";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import type { PerfEnv, PerfUiEnv } from "./env";
import { appendSample, type MetricsOut, metricsOutFor } from "./metrics-out";
import { createSampler, type FrameRateSource } from "./metrics-sampler";
import type { PerfDone, PerfEngineDeps, PerfOutcome, PerfTarget } from "./types";

/** What a `metrics` run takes: durations like `500ms` / `2s` / `1m` (a one-shot reads for 3s). */
export type MetricsParams = { interval?: string; duration?: string; watch?: boolean };

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 200;
/** A one-shot reads the baseline plus a few CPU intervals: enough for a figure, short enough to be a probe. */
const DEFAULT_ONE_SHOT_MS = 3000;
const KB_PER_MB = 1024;
/** The exit code of a run ended by Ctrl-C (the `warden ui` convention). */
const INTERRUPTED_EXIT = 130;

export type SeriesPlan = { intervalMs: number; durationMs: number };

export function planSeries(opts: MetricsParams): Result<SeriesPlan, WardenError> {
	const interval = opts.interval === undefined ? DEFAULT_INTERVAL_MS : perfDuration.parseDuration(opts.interval);
	if (interval === undefined) {
		return {
			success: false,
			error: opErrors.opError("usage", `--interval must be a duration like 500ms or 2s, got "${opts.interval}"`),
		};
	}
	if (interval < MIN_INTERVAL_MS) {
		return {
			success: false,
			error: opErrors.opError(
				"usage",
				`--interval must be at least ${MIN_INTERVAL_MS}ms: sampling faster skews the app`
			),
		};
	}
	const fallback = opts.watch === true ? HARD_MAX_DURATION_MS : DEFAULT_ONE_SHOT_MS;
	const duration = opts.duration === undefined ? fallback : perfDuration.parseDuration(opts.duration);
	if (duration === undefined) {
		return {
			success: false,
			error: opErrors.opError("usage", `--duration must be a duration like 10s or 1m, got "${opts.duration}"`),
		};
	}
	return resultFactory.ok({ intervalMs: interval, durationMs: Math.min(duration, HARD_MAX_DURATION_MS) });
}

/** What a series run reaches the clock and the user's interrupt through; tests inject fakes. */
export type SeriesIo = {
	/** wait `ms`, or until `signal` aborts */
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	/** aborted by Ctrl-C / the caller's signal */
	signal: AbortSignal;
	/** an fps source (Android gfxinfo); the fps column is present only when one is given */
	fps?: FrameRateSource | undefined;
};

export type SeriesResult = {
	samples: MetricSample[];
	aborted: boolean;
	/** why sampling ended early (the app went away) */
	stopped?: WardenError;
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
	ctx: PerfEnv,
	io: SeriesIo,
	sampler: { sample: () => Promise<Result<MetricSample, WardenError>> },
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

/** Everything a finished series reports: the `PerfDone<MetricsResult>` for `runPerf` (text, JSON result, warnings, exit 130 when interrupted). */
function seriesSuccess(
	ctx: PerfUiEnv,
	target: PerfTarget,
	app: string,
	intervalMs: number,
	out: MetricsOut,
	series: SeriesResult
): Result<PerfDone<MetricsResult>, WardenError> {
	const summary = sampleSeries.summarize(series.samples);
	if (summary === undefined) {
		return {
			success: false,
			error: series.stopped ?? opErrors.opError("interrupted", "interrupted before the first sample"),
		};
	}
	const finding = sampleSeries.memoryGrowthFinding(summary);
	const device = describeTarget(target);
	return resultFactory.ok({
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
		...(series.aborted ? { exit: INTERRUPTED_EXIT } : {}),
	});
}

/** The `result` of `perf metrics --json`. */
export type MetricsResult = {
	app: string;
	intervalMs: number;
	summary: SeriesSummary;
	findings: Finding[];
	/** the samples file (`samples.jsonl`) */
	samples: string;
	sessionId?: string;
	interrupted?: true;
};

/**
 * Sample the app of a resolved device per `planned` and report the series: every sample is appended to the samples
 * file (the running session's, else a one-shot dir) as it is taken and handed to `onSample`. Observe-only.
 */
export async function metricsSeries(
	ctx: PerfUiEnv,
	deps: PerfEngineDeps,
	target: PerfTarget,
	app: string,
	planned: SeriesPlan,
	io: SeriesIo,
	onSample: (sample: MetricSample, all: readonly MetricSample[]) => void = () => {}
): PerfOutcome<MetricsResult> {
	const out = metricsOutFor(ctx, deps.session, target.udid);
	const sampler = await createSampler(ctx, { udid: target.udid, platform: target.platform, app }, out.startMs);
	if (!sampler.success) return sampler;
	const series = await runSeries(ctx, io, sampler.data, {
		...planned,
		startMs: out.startMs,
		file: out.file,
		onSample,
	});
	return seriesSuccess(ctx, target, app, planned.intervalMs, out, series);
}
