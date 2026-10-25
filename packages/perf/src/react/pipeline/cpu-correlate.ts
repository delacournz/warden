import type { CallFrame, CpuProfile } from "../../js/cpu-profile";
import type { HotCommit } from "./hot-commits";

export type CpuFunction = { name: string; file?: string; line?: number; selfMs: number };

/** How a frame is named in the report: the caller maps it through whatever source info it has. */
export type FrameLabel = (frame: CallFrame) => { name: string; file?: string; line?: number };

export type CpuIndex = {
	/** device wall ms of each sample, ascending */
	wallMs: number[];
	/** ms each sample stands for */
	weightMs: number[];
	/** leaf node of each sample */
	nodeIds: number[];
	frames: Map<number, CallFrame>;
};

const SKIPPED = new Set(["(root)", "(idle)", "(program)", "(garbage collector)"]);

/**
 * Index a Hermes cpuprofile by device wall time. `startWallMs` is the device `Date.now()` taken when the profiler
 * started (the `deviceWallMs` of `js/hotspots.json`'s anchor); sample times are offsets from `profile.startTime`.
 */
export function indexProfile(profile: CpuProfile, startWallMs: number): CpuIndex {
	const wallMs: number[] = [];
	const weightMs: number[] = [];
	let elapsedUs = 0;
	const count = profile.samples.length;
	for (let i = 0; i < count; i++) {
		elapsedUs += profile.timeDeltas[i] ?? 0;
		wallMs.push(startWallMs + elapsedUs / 1000);
		const next = profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0;
		weightMs.push(Math.max(0, next) / 1000);
	}
	return {
		wallMs,
		weightMs,
		nodeIds: [...profile.samples],
		frames: new Map(profile.nodes.map((n) => [n.id, n.callFrame])),
	};
}

/** First index whose time is at or after `t`. */
function lowerBound(times: readonly number[], t: number): number {
	let lo = 0;
	let hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((times[mid] ?? 0) < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** The functions with the most self time inside `[fromMs, toMs]` (device wall), found by binary search over the samples. */
export function topFunctionsIn(
	index: CpuIndex,
	fromMs: number,
	toMs: number,
	label: FrameLabel,
	limit = 3
): CpuFunction[] {
	const first = lowerBound(index.wallMs, fromMs);
	const end = lowerBound(index.wallMs, toMs);
	const byKey = new Map<string, CpuFunction>();
	for (let i = first; i < end; i++) {
		const frame = index.frames.get(index.nodeIds[i] ?? -1);
		if (frame === undefined || SKIPPED.has(frame.functionName)) continue;
		const at = label(frame);
		const key = `${at.file ?? ""}:${at.line ?? 0}:${at.name}`;
		const entry = byKey.get(key) ?? { ...at, selfMs: 0 };
		entry.selfMs += index.weightMs[i] ?? 0;
		byKey.set(key, entry);
	}
	return [...byKey.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, limit);
}

export type HotCommitWithCpu = HotCommit & { cpu: CpuFunction[] };

/** Each hot commit with the JS functions that were running during its window. */
export function correlateCpu(hot: readonly HotCommit[], index: CpuIndex, label: FrameLabel): HotCommitWithCpu[] {
	return hot.map((h) => ({ ...h, cpu: topFunctionsIn(index, h.wallMs, h.wallMs + h.durationMs, label) }));
}
