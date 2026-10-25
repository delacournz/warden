import { z } from "zod";
import type { Finding } from "../shared/findings.types";

/** One reading of the app: what a row of `metrics/samples.jsonl` holds. */
export const sampleSchema = z.object({
	/** host wall clock, ms */
	wallMs: z.number(),
	/** ms since the series (or session) started */
	atMs: z.number(),
	pid: z.number(),
	/** % of one core over the interval since the previous sample; absent on the first (baseline) sample */
	cpuPct: z.number().optional(),
	rssKb: z.number(),
	/** Android only: proportional set size from `dumpsys meminfo` */
	pssKb: z.number().optional(),
	fps: z.number().optional(),
});

export type MetricSample = z.infer<typeof sampleSchema>;

export const encodeSample = (sample: MetricSample): string => `${JSON.stringify(sample)}\n`;

/** Rows of a samples.jsonl; malformed lines are skipped (a collector killed mid-write leaves a torn last line). */
export function decodeSamples(text: string): MetricSample[] {
	return text.split("\n").flatMap((line) => {
		if (line.trim() === "") return [];
		try {
			const parsed = sampleSchema.safeParse(JSON.parse(line));
			return parsed.success ? [parsed.data] : [];
		} catch {
			return [];
		}
	});
}

export type Stat = { min: number; avg: number; p95: number; max: number };

/** min/avg/p95 (nearest rank)/max; undefined for no values. */
export function stat(values: readonly number[]): Stat | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
	const sum = sorted.reduce((a, b) => a + b, 0);
	return {
		min: sorted[0] ?? 0,
		avg: sum / sorted.length,
		p95: sorted[rank - 1] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
	};
}

export type MemoryGrowth = {
	metric: "pss" | "rss";
	startKb: number;
	endKb: number;
	/** least-squares slope over the whole series */
	slopeKbPerSec: number;
	/** share of consecutive readings that did not go down: a steady climb is near 1, a sawtooth (GC) is not */
	risingShare: number;
};

export type SeriesSummary = {
	count: number;
	durationMs: number;
	cpuPct?: Stat;
	rssKb: Stat;
	pssKb?: Stat;
	fps?: Stat;
	growth?: MemoryGrowth;
};

/** Least-squares slope of `ys` over `xs`. */
function slope(xs: readonly number[], ys: readonly number[]): number {
	const n = xs.length;
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		const dx = (xs[i] ?? 0) - mx;
		num += dx * ((ys[i] ?? 0) - my);
		den += dx * dx;
	}
	return den === 0 ? 0 : num / den;
}

/** PSS when every sample has it (Android), else RSS. */
function growthOf(samples: readonly MetricSample[]): MemoryGrowth | undefined {
	if (samples.length < 2) return undefined;
	const usePss = samples.every((s) => s.pssKb !== undefined);
	const ys = samples.map((s) => (usePss ? (s.pssKb ?? 0) : s.rssKb));
	const xs = samples.map((s) => s.atMs / 1000);
	let rising = 0;
	for (let i = 1; i < ys.length; i++) if ((ys[i] ?? 0) >= (ys[i - 1] ?? 0)) rising++;
	return {
		metric: usePss ? "pss" : "rss",
		startKb: ys[0] ?? 0,
		endKb: ys[ys.length - 1] ?? 0,
		slopeKbPerSec: slope(xs, ys),
		risingShare: rising / (ys.length - 1),
	};
}

/** Summary of a series, or undefined for an empty one. */
export function summarize(samples: readonly MetricSample[]): SeriesSummary | undefined {
	const first = samples[0];
	const last = samples[samples.length - 1];
	const rssKb = stat(samples.map((s) => s.rssKb));
	if (first === undefined || last === undefined || rssKb === undefined) return undefined;
	const cpuPct = stat(samples.flatMap((s) => s.cpuPct ?? []));
	const pssKb = stat(samples.flatMap((s) => s.pssKb ?? []));
	const fps = stat(samples.flatMap((s) => s.fps ?? []));
	const growth = growthOf(samples);
	return {
		count: samples.length,
		durationMs: last.atMs - first.atMs,
		...(cpuPct !== undefined ? { cpuPct } : {}),
		rssKb,
		...(pssKb !== undefined ? { pssKb } : {}),
		...(fps !== undefined ? { fps } : {}),
		...(growth !== undefined ? { growth } : {}),
	};
}

/** A leak hint needs a long enough, steadily rising series: shorter or noisier ones say nothing. */
export const LEAK_MIN_SAMPLES = 6;
export const LEAK_MIN_SPAN_MS = 5_000;
export const LEAK_MIN_GROWTH_KB = 1024;
export const LEAK_MIN_SLOPE_KB_PER_SEC = 50;
export const LEAK_MIN_RISING_SHARE = 0.7;
const CRITICAL_SLOPE_KB_PER_SEC = 1024;

const mb = (kb: number): string => `${(kb / 1024).toFixed(1)} MB`;

/** The `memory-growth` finding for a steadily climbing series, else undefined. */
export function memoryGrowthFinding(summary: SeriesSummary): Finding | undefined {
	const g = summary.growth;
	if (g === undefined) return undefined;
	const growthKb = g.endKb - g.startKb;
	const steady =
		summary.count >= LEAK_MIN_SAMPLES &&
		summary.durationMs >= LEAK_MIN_SPAN_MS &&
		growthKb >= LEAK_MIN_GROWTH_KB &&
		g.slopeKbPerSec >= LEAK_MIN_SLOPE_KB_PER_SEC &&
		g.risingShare >= LEAK_MIN_RISING_SHARE;
	if (!steady) return undefined;
	return {
		kind: "memory-growth",
		severity: g.slopeKbPerSec >= CRITICAL_SLOPE_KB_PER_SEC ? "critical" : "warn",
		costMs: 0,
		slopeKbPerSec: Math.round(g.slopeKbPerSec),
		evidence: `${g.metric} grew ${mb(growthKb)} in ${(summary.durationMs / 1000).toFixed(0)}s (${mb(g.startKb)} to ${mb(g.endKb)}, +${Math.round(g.slopeKbPerSec)} KB/s, rising in ${Math.round(g.risingShare * 100)}% of readings)`,
		fix: "Steady growth under a fixed workload often means a leak: look for listeners, timers, caches or closures that are never released.",
		next: ["warden perf memory --snapshot", "warden perf heap snapshot"],
	};
}
