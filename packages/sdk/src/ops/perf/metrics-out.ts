import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type MetricSample, sampleSeries } from "@delacour/warden-perf/metrics/series";
import { sessionCodec } from "@delacour/warden-perf/shared/session.schema";
import type { PerfEnv } from "./env";
import { perfPaths } from "./paths";
import { perfSessionStore, type SessionDeps } from "./session";

/** Where a series goes: `<dir>/metrics/<file>`, timed from `startMs`. */
export type MetricsOut = { file: string; startMs: number; sessionId?: string };

/** `metrics/samples.jsonl`: the series a session's collector writes. */
export const SAMPLES_FILE = join("metrics", "samples.jsonl");

/** What a hand-run `perf metrics` writes into a session whose collector is already sampling (two writers, one file would interleave). */
const MANUAL_SAMPLES_FILE = join("metrics", "samples-manual.jsonl");

/** MetricsOutPaths: metrics out. */
export class MetricsOutPaths {
	/**
	 * The file a `perf metrics` run appends to. With a session running on the device it is that session's
	 * `metrics/samples.jsonl` (its own `samples-manual.jsonl` while the collector samples), timed from the session
	 * start so rows line up with marks. Otherwise a one-shot dir under `$WARDEN_HOME/perf` (its name is not a
	 * session id, so session listing and sweeping ignore it).
	 */
	metricsOutFor(ctx: PerfEnv, deps: SessionDeps, udid: string): MetricsOut {
		const session = perfSessionStore.activeSessionFor(ctx, deps, udid);
		if (session !== undefined) {
			const collecting = session.capturers.some((c) => c.kind === "metrics" && c.state === "running");
			return {
				file: join(perfPaths.sessionDir(ctx, session.id), collecting ? MANUAL_SAMPLES_FILE : SAMPLES_FILE),
				startMs: session.startedAt.wallMs,
				sessionId: session.id,
			};
		}
		const now = ctx.now();
		return {
			file: join(perfPaths.perfRoot(ctx), `metrics-${sessionCodec.formatSessionId(now, deps.random())}`, SAMPLES_FILE),
			startMs: now,
		};
	}

	/** Append one sample row (creating the directory on the first). */
	appendSample(file: string, sample: MetricSample): void {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, sampleSeries.encodeSample(sample));
	}

	/**
	 * Where a one-off artifact (memgraph, hprof) goes: the running session's dir, else a one-shot dir under
	 * `$WARDEN_HOME/perf` named `memory-<id>` (not a session id, so session listing ignores it).
	 */
	artifactDirFor(ctx: PerfEnv, deps: SessionDeps, udid: string): { dir: string; sessionId?: string } {
		const session = perfSessionStore.activeSessionFor(ctx, deps, udid);
		if (session !== undefined) return { dir: perfPaths.sessionDir(ctx, session.id), sessionId: session.id };
		return { dir: join(perfPaths.perfRoot(ctx), `memory-${sessionCodec.formatSessionId(ctx.now(), deps.random())}`) };
	}
}

export const metricsOutPaths = new MetricsOutPaths();
