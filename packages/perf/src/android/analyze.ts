import type { Finding } from "../shared/findings.types";
import { num, type TpRow } from "./tp-output";

/** Self-time share of the app's samples at which a function is reported. */
export const HOTSPOT_WARN_PCT = 3;
export const HOTSPOT_CRITICAL_PCT = 15;
/** Frames this long (or longer) are reported as hangs. */
export const HANG_WARN_MS = 100;
export const HANG_CRITICAL_MS = 700;
/** Share of the app's frames that missed their deadline. */
export const JANK_WARN_PCT = 5;
export const JANK_CRITICAL_PCT = 15;
/** RSS must grow this fast, and this much overall, to count as a leak candidate. */
export const RSS_WARN_KB_PER_SEC = 500;
export const RSS_CRITICAL_KB_PER_SEC = 5_000;
export const RSS_MIN_GROWTH_KB = 10_240;
export const RSS_MIN_SPAN_SEC = 5;

const NS_PER_MS = 1e6;
const ms = (ns: number): number => ns / NS_PER_MS;

export type CpuFunction = { thread: string; function: string; dso: string; samples: number; selfPct: number };
export type CpuThread = { thread: string; samples: number; pct: number };
export type CpuAnalysis = { totalSamples: number; threads: CpuThread[]; functions: CpuFunction[] };

/** Group `cpu-hotspots` rows into per-thread and per-function shares of all the app's samples. */
export function analyzeCpu(rows: readonly TpRow[]): CpuAnalysis {
	const total = rows.reduce((sum, r) => sum + num(r, "samples"), 0);
	const pct = (n: number): number => (total === 0 ? 0 : (n / total) * 100);
	const byThread = new Map<string, number>();
	const functions: CpuFunction[] = [];
	for (const r of rows) {
		const samples = num(r, "samples");
		if (samples === 0) continue;
		const thread = r.thread ?? "";
		byThread.set(thread, (byThread.get(thread) ?? 0) + samples);
		functions.push({ thread, function: r.function ?? "", dso: r.dso ?? "", samples, selfPct: pct(samples) });
	}
	functions.sort((a, b) => b.samples - a.samples);
	const threads = [...byThread].map(([thread, samples]) => ({ thread, samples, pct: pct(samples) }));
	threads.sort((a, b) => b.samples - a.samples);
	return { totalSamples: total, threads, functions };
}

/** Findings for functions over the warn share of samples; `sampleHz` turns samples into CPU ms. */
export function cpuFindings(cpu: CpuAnalysis, sampleHz: number): Finding[] {
	return cpu.functions
		.filter((f) => f.selfPct >= HOTSPOT_WARN_PCT)
		.map((f) => ({
			kind: "native-hotspot" as const,
			severity: f.selfPct > HOTSPOT_CRITICAL_PCT ? ("critical" as const) : ("warn" as const),
			costMs: (f.samples * 1000) / sampleHz,
			thread: f.thread,
			function: f.function,
			selfPct: Math.round(f.selfPct * 10) / 10,
			evidence: `${f.function}${f.dso === "" ? "" : ` (${f.dso.split("/").pop()})`} is ${f.selfPct.toFixed(1)}% of the app's CPU samples on ${f.thread}`,
			fix: "reduce work in this function or move it off that thread; verify with perf record --native after the change",
			next: [`warden perf query <id> cpu --top`],
		}));
}

export type HangBuckets = {
	running: number;
	runnable: number;
	sleeping: number;
	io: number;
	gc: number;
	other: number;
};
export type Hang = { atMs: number; durMs: number; jankType: string; main: HangBuckets; layer: string };
export type HangAnalysis = { hangs: Hang[]; totalFrames: number; missedFrames: number };

const emptyBuckets = (): HangBuckets => ({ running: 0, runnable: 0, sleeping: 0, io: 0, gc: 0, other: 0 });

/** Join `ui-hangs` (missed frames) with `hang-folds-batched` (main-thread state per frame) by start time. */
export function analyzeHangs(frames: readonly TpRow[], folds: readonly TpRow[]): HangAnalysis {
	const byAt = new Map<number, HangBuckets>();
	for (const r of folds) {
		const key = num(r, "at_ns");
		const buckets = byAt.get(key) ?? emptyBuckets();
		const bucket = r.bucket ?? "other";
		const name = bucket in buckets ? (bucket as keyof HangBuckets) : "other";
		buckets[name] += ms(num(r, "ns"));
		byAt.set(key, buckets);
	}
	const hangs = frames.map((r): Hang => {
		const at = num(r, "at_ns");
		return {
			atMs: ms(at),
			durMs: ms(num(r, "dur_ns")),
			jankType: r.jank_type ?? "",
			layer: r.layer ?? "",
			main: byAt.get(at) ?? emptyBuckets(),
		};
	});
	return {
		hangs,
		missedFrames: frames.length,
		totalFrames: frames.reduce((max, r) => Math.max(max, num(r, "total_frames")), 0),
	};
}

/** One-line main-thread split of a hang: `running 300ms · runnable 20ms · …` (zero buckets omitted). */
export function describeBuckets(b: HangBuckets): string {
	return (Object.keys(b) as Array<keyof HangBuckets>)
		.filter((k) => b[k] >= 1)
		.map((k) => `${k} ${Math.round(b[k])}ms`)
		.join(" · ");
}

function dominant(b: HangBuckets): string {
	const entries = (Object.keys(b) as Array<keyof HangBuckets>).map((k) => [k, b[k]] as const);
	entries.sort((x, y) => y[1] - x[1]);
	const [top] = entries;
	if (top === undefined || top[1] < 1) return "no main-thread data for this frame";
	switch (top[0]) {
		case "running":
			return "the main thread was busy running code: profile it (perf query <id> cpu --top)";
		case "runnable":
			return "the main thread was ready but not scheduled: CPU contention from other threads or processes";
		case "io":
			return "the main thread blocked on I/O: move disk/network work off it";
		case "sleeping":
			return "the main thread was asleep/blocked: look for locks or binder calls";
		case "gc":
			return "garbage collection overlapped the frame: cut allocation churn";
		default:
			return "see the main-thread state split";
	}
}

export function hangFindings(analysis: HangAnalysis): Finding[] {
	const findings: Finding[] = [];
	for (const h of analysis.hangs) {
		if (h.durMs < HANG_WARN_MS) continue;
		findings.push({
			kind: "hang",
			severity: h.durMs >= HANG_CRITICAL_MS ? "critical" : "warn",
			costMs: h.durMs,
			atMs: Math.round(h.atMs),
			evidence: `frame of ${Math.round(h.durMs)}ms at ${(h.atMs / 1000).toFixed(1)}s missed its deadline; main thread ${describeBuckets(h.main) || "n/a"}`,
			fix: dominant(h.main),
			next: ["warden perf query <id> stacks hang"],
		});
	}
	const pct = analysis.totalFrames === 0 ? 0 : (analysis.missedFrames / analysis.totalFrames) * 100;
	if (pct >= JANK_WARN_PCT) {
		findings.push({
			kind: "jank",
			severity: pct >= JANK_CRITICAL_PCT ? "critical" : "warn",
			costMs: 0,
			jankPct: Math.round(pct * 10) / 10,
			evidence: `${analysis.missedFrames} of ${analysis.totalFrames} frames (${pct.toFixed(1)}%) missed the app deadline`,
			fix: "start with the longest hangs; each one lists what the main thread was doing",
			next: ["warden perf frames"],
		});
	}
	return findings;
}

export type RssAnalysis = {
	samples: number;
	startKb: number;
	endKb: number;
	peakKb: number;
	spanSec: number;
	slopeKbPerSec: number;
};

/** Least-squares slope of the `memory-rss` series (bytes over ns), in KB/s. */
export function analyzeRss(rows: readonly TpRow[]): RssAnalysis | undefined {
	const pts = rows.map((r) => ({ t: num(r, "t_ns") / 1e9, kb: num(r, "bytes") / 1024 }));
	const [first] = pts;
	const last = pts.at(-1);
	if (first === undefined || last === undefined || pts.length < 2) return undefined;
	const n = pts.length;
	const mt = pts.reduce((s, p) => s + p.t, 0) / n;
	const mk = pts.reduce((s, p) => s + p.kb, 0) / n;
	const sxx = pts.reduce((s, p) => s + (p.t - mt) ** 2, 0);
	const sxy = pts.reduce((s, p) => s + (p.t - mt) * (p.kb - mk), 0);
	return {
		samples: n,
		startKb: first.kb,
		endKb: last.kb,
		peakKb: Math.max(...pts.map((p) => p.kb)),
		spanSec: last.t - first.t,
		slopeKbPerSec: sxx === 0 ? 0 : sxy / sxx,
	};
}

export function rssFindings(rss: RssAnalysis | undefined): Finding[] {
	if (rss === undefined) return [];
	const growth = rss.endKb - rss.startKb;
	if (rss.spanSec < RSS_MIN_SPAN_SEC || growth < RSS_MIN_GROWTH_KB || rss.slopeKbPerSec < RSS_WARN_KB_PER_SEC)
		return [];
	return [
		{
			kind: "memory-growth",
			severity: rss.slopeKbPerSec >= RSS_CRITICAL_KB_PER_SEC ? "critical" : "warn",
			costMs: 0,
			slopeKbPerSec: Math.round(rss.slopeKbPerSec),
			evidence: `RSS grew ${(growth / 1024).toFixed(1)} MB in ${rss.spanSec.toFixed(0)}s (${Math.round(rss.slopeKbPerSec)} KB/s)`,
			fix: "repeat the flow and compare heap dumps to find what is retained",
			next: ["warden perf heap snapshot"],
		},
	];
}

export type ThreadBreakdown = {
	thread: string;
	tid: number;
	runningMs: number;
	runnableMs: number;
	ioMs: number;
	sleepingMs: number;
};

export function analyzeThreads(rows: readonly TpRow[]): ThreadBreakdown[] {
	return rows.map((r) => ({
		thread: r.thread ?? "",
		tid: num(r, "tid"),
		runningMs: ms(num(r, "running_ns")),
		runnableMs: ms(num(r, "runnable_ns")),
		ioMs: ms(num(r, "io_ns")),
		sleepingMs: ms(num(r, "sleeping_ns")),
	}));
}
