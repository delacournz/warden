import type { Finding } from "../shared/findings.types";
import type { GfxInfo } from "./gfxinfo";

export const DEADLINE_MIN_MS = 4;
export const DEADLINE_MAX_MS = 50;
export const FROZEN_FRAME_MS = 700;
export const CLUSTER_GAP_MS = 500;
export const MAX_WINDOWS = 3;
const DEFAULT_DEADLINE_MS = 1000 / 60;

export type JankWindow = {
	/** ms from the session start (or from the first sampled frame without a session) */
	startOffsetMs: number;
	endOffsetMs: number;
	missedDeadlineFrameCount: number;
	worstFrameMs: number;
	/** the last mark at or before the window start */
	mark?: string;
};

export type FramesReport = {
	/** frames in the sampled PROFILEDATA buffer (the OS keeps the latest ~120) */
	sampledFrames: number;
	/** frame budget: median vsync interval clamped to 4..50ms */
	deadlineMs: number;
	refreshHz: number;
	/** rendered frames per second over active stretches, capped at the refresh rate */
	fps: number;
	/** the OS summary's janky % since the last reset; the sample's missed-deadline % without one */
	jankPct: number;
	/** missed-deadline % of the sampled frames */
	sampleJankPct: number;
	totalFrames: number;
	jankyFrames: number;
	droppedFrames: number;
	frozenFrames: number;
	worstFrameMs: number;
	percentilesMs: { p50?: number; p90?: number; p95?: number; p99?: number };
	worstWindows: JankWindow[];
};

export type Anchor = {
	/** host ms since the session started when the dump was read */
	readAtSessionMs: number;
	marks: ReadonlyArray<{ label: string; atMs: number }>;
};

const round = (n: number, digits = 1): number => {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
};

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Frame budget from the median gap between consecutive intended vsyncs, clamped to 4..50ms. */
export function deadlineFor(intendedNs: readonly number[]): number {
	const gaps: number[] = [];
	for (let i = 1; i < intendedNs.length; i++) gaps.push(((intendedNs[i] ?? 0) - (intendedNs[i - 1] ?? 0)) / 1e6);
	const m = median(gaps);
	if (m === undefined) return DEFAULT_DEADLINE_MS;
	return Math.min(DEADLINE_MAX_MS, Math.max(DEADLINE_MIN_MS, m));
}

function frameCounts(durations: readonly number[], deadlineMs: number) {
	let missed = 0;
	let dropped = 0;
	let frozen = 0;
	let worst = 0;
	for (const d of durations) {
		if (d > deadlineMs) {
			missed++;
			dropped += Math.max(0, Math.ceil(d / deadlineMs) - 1);
		}
		if (d > FROZEN_FRAME_MS) frozen++;
		worst = Math.max(worst, d);
	}
	return { missed, dropped, frozen, worst };
}

/** Total time and gap count over consecutive vsync gaps of at most 500ms (idle stretches don't lower fps). */
function activeSpan(intendedNs: readonly number[]): { activeMs: number; activeGaps: number } {
	let activeMs = 0;
	let activeGaps = 0;
	for (let i = 1; i < intendedNs.length; i++) {
		const gap = ((intendedNs[i] ?? 0) - (intendedNs[i - 1] ?? 0)) / 1e6;
		if (gap <= CLUSTER_GAP_MS) {
			activeMs += gap;
			activeGaps++;
		}
	}
	return { activeMs, activeGaps };
}

/** Turn a parsed dump into fps, jank, dropped/frozen frames and the worst jank windows. */
export function analyzeFrames(info: GfxInfo, anchor?: Anchor): FramesReport {
	const { frames } = info;
	const deadlineMs = deadlineFor(frames.map((f) => f.intendedVsyncNs));
	const durations = frames.map((f) => (f.completedNs - f.intendedVsyncNs) / 1e6);

	const counts = frameCounts(durations, deadlineMs);
	const { activeMs, activeGaps } = activeSpan(frames.map((f) => f.intendedVsyncNs));
	const refreshHz = 1000 / deadlineMs;
	const fps = activeMs > 0 ? Math.min(refreshHz, (activeGaps / activeMs) * 1000) : 0;

	const sampleJankPct = frames.length === 0 ? 0 : (counts.missed / frames.length) * 100;
	const summary = info.summary;

	return {
		sampledFrames: frames.length,
		deadlineMs: round(deadlineMs, 2),
		refreshHz: round(refreshHz, 0),
		fps: round(fps, 1),
		jankPct: round(summary?.jankyPct ?? sampleJankPct, 2),
		sampleJankPct: round(sampleJankPct, 2),
		totalFrames: summary?.totalFrames ?? frames.length,
		jankyFrames: summary?.jankyFrames ?? counts.missed,
		droppedFrames: counts.dropped,
		frozenFrames: counts.frozen,
		worstFrameMs: round(counts.worst, 1),
		percentilesMs: summary?.percentilesMs ?? {},
		worstWindows: jankWindows(info, deadlineMs, durations, anchor),
	};
}

function jankWindows(info: GfxInfo, deadlineMs: number, durations: number[], anchor?: Anchor): JankWindow[] {
	const { frames } = info;
	const clusters: number[][] = [];
	let lastEndNs = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < frames.length; i++) {
		if ((durations[i] ?? 0) <= deadlineMs) continue;
		const f = frames[i];
		if (f === undefined) continue;
		const current = clusters[clusters.length - 1];
		if (current !== undefined && (f.intendedVsyncNs - lastEndNs) / 1e6 <= CLUSTER_GAP_MS) current.push(i);
		else clusters.push([i]);
		lastEndNs = f.completedNs;
	}

	const lastFrame = frames[frames.length - 1];
	const originNs = frames[0]?.intendedVsyncNs ?? 0;
	// sessionMs(frame) = read time - how long before the dump the frame happened (frame clock = device uptime)
	const toOffsetMs = (ns: number): number => {
		if (anchor === undefined || lastFrame === undefined) return (ns - originNs) / 1e6;
		const nowMs = info.uptimeMs ?? lastFrame.completedNs / 1e6;
		return anchor.readAtSessionMs - (nowMs - ns / 1e6);
	};

	const windows = clusters.map((idx): JankWindow => {
		const first = frames[idx[0] ?? 0];
		const last = frames[idx[idx.length - 1] ?? 0];
		const startOffsetMs = round(toOffsetMs(first?.intendedVsyncNs ?? 0), 0);
		const mark = anchor?.marks.filter((m) => m.atMs <= startOffsetMs).at(-1)?.label;
		return {
			startOffsetMs,
			endOffsetMs: round(toOffsetMs(last?.completedNs ?? 0), 0),
			missedDeadlineFrameCount: idx.length,
			worstFrameMs: round(Math.max(...idx.map((i) => durations[i] ?? 0)), 1),
			...(mark !== undefined ? { mark } : {}),
		};
	});
	return windows
		.sort((a, b) => b.missedDeadlineFrameCount - a.missedDeadlineFrameCount || b.worstFrameMs - a.worstFrameMs)
		.slice(0, MAX_WINDOWS);
}

/** A `jank` finding when the report is bad enough to act on; undefined when frames are healthy. */
export function jankFinding(report: FramesReport): Extract<Finding, { kind: "jank" }> | undefined {
	const { jankPct, frozenFrames } = report;
	if (jankPct < 2 && frozenFrames === 0) return undefined;
	const severity = jankPct >= 25 || frozenFrames >= 3 ? "critical" : jankPct >= 5 || frozenFrames > 0 ? "warn" : "info";
	const worst = report.worstWindows[0];
	const where = worst
		? `; worst window +${(worst.startOffsetMs / 1000).toFixed(1)}s..+${(worst.endOffsetMs / 1000).toFixed(1)}s (${worst.missedDeadlineFrameCount} frames, slowest ${worst.worstFrameMs}ms${worst.mark ? `, after mark "${worst.mark}"` : ""})`
		: "";
	return {
		kind: "jank",
		severity,
		costMs: round(report.worstFrameMs, 0),
		jankPct,
		evidence: `${jankPct}% janky frames at ${report.refreshHz}Hz (${report.droppedFrames} dropped, ${frozenFrames} frozen >${FROZEN_FRAME_MS}ms), ~${report.fps} fps${where}`,
		fix: "record the interaction with warden perf start and mark it; in the worst window look for work on the main thread, large lists without virtualization, or layout thrash",
		next: ["warden perf mark <label>", "warden perf frames --reset"],
	};
}
