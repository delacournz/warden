import { join } from "node:path";
import type { MetricSample } from "@delacour/warden-perf/metrics/series";
import type { UiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { appendSample, SAMPLES_FILE } from "./metrics-out";
import { createSampler, type FrameRateSource, type MetricsTarget } from "./metrics-sampler";

/** The collector samples the app this often while a session records metrics. */
export const COLLECT_METRICS_INTERVAL_MS = 1000;

export type MetricsTicker = {
	/** Take one reading and append it to `<sessionDir>/metrics/samples.jsonl`. Undefined when the app is not running at the moment (a gap, not a failure: the app may be restarting). */
	tick: () => Promise<MetricSample | undefined>;
};

/**
 * What `perf-collect` calls to record metrics into a session: build once (`startMs` = the session's
 * `startedAt.wallMs`, so rows align with marks), then `tick()` every `COLLECT_METRICS_INTERVAL_MS`. The
 * first tick is the CPU baseline. Observe-only: reads `ps` / `top` / `dumpsys meminfo`, never leases.
 */
export async function createMetricsTicker(
	ctx: CommandContext,
	input: { target: MetricsTarget; sessionDir: string; startMs: number; fps?: FrameRateSource }
): Promise<{ success: true; data: MetricsTicker } | { success: false; error: UiError }> {
	const sampler = await createSampler(ctx, input.target, input.startMs);
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
				appendSample(file, sample);
				return sample;
			},
		},
	};
}
