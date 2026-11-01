import { join } from "node:path";
import type { MetricSample } from "@delacour/warden-perf/metrics/series";
import type { WardenError } from "@delacour/warden-types/error";
import type { PerfEnv } from "./env";
import { metricsOutPaths, SAMPLES_FILE } from "./metrics-out";
import { type FrameRateSource, type MetricsTarget, metricsSamplers } from "./metrics-sampler";

/** The collector samples the app this often while a session records metrics. */
export const COLLECT_METRICS_INTERVAL_MS = 1000;

export type MetricsTicker = {
	/** Take one reading and append it to `<sessionDir>/metrics/samples.jsonl`. Undefined when the app is not running at the moment (a gap, not a failure: the app may be restarting). */
	tick: () => Promise<MetricSample | undefined>;
};

/** MetricsTickers: collect metrics. */
export class MetricsTickers {
	/**
	 * What `perf-collect` calls to record metrics into a session: build once (`startMs` = the session's
	 * `startedAt.wallMs`, so rows align with marks), then `tick()` every `COLLECT_METRICS_INTERVAL_MS`. The
	 * first tick is the CPU baseline. Observe-only: reads `ps` / `top` / `dumpsys meminfo`, never leases.
	 */
	async createMetricsTicker(
		ctx: PerfEnv,
		input: { target: MetricsTarget; sessionDir: string; startMs: number; fps?: FrameRateSource }
	): Promise<{ success: true; data: MetricsTicker } | { success: false; error: WardenError }> {
		const sampler = await metricsSamplers.createSampler(ctx, input.target, input.startMs);
		if (!sampler.success) return sampler;
		const file = join(input.sessionDir, SAMPLES_FILE);
		return {
			success: true,
			data: {
				tick: async () => {
					const read = await sampler.data.sample();
					if (!read.success) return undefined;
					const fps = await input.fps?.({ atMs: read.data.atMs, wallMs: read.data.wallMs });
					const sample = fps === undefined ? read.data : { ...read.data, fps };
					metricsOutPaths.appendSample(file, sample);
					return sample;
				},
			},
		};
	}
}

export const metricsTickers = new MetricsTickers();
