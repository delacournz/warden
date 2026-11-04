/**
 * Pure pieces of the `warden dev` reel: asciicast text on the video clock, the speed-ramp segment map
 * (real seconds -> output seconds) and the caption spans. No IO.
 */
import type { DevBeat, RecordedBeat } from "./demo.types";

export type Chunk = { atS: number; data: string };

const round = (n: number, digits = 3) => Number(n.toFixed(digits));

/** asciicast v2: header, then one `[seconds, "o", data]` per PTY chunk. Times are clamped to >= 0 and non-decreasing. */
export function castText(chunks: readonly Chunk[], cols: number, rows: number): string {
	const header = { version: 2, width: cols, height: rows, env: { TERM: "xterm-256color" } };
	let last = 0;
	const lines = chunks.map((c) => {
		last = Math.max(last, round(Math.max(0, c.atS), 3));
		return JSON.stringify([last, "o", c.data]);
	});
	return `${[JSON.stringify(header), ...lines].join("\n")}\n`;
}

export type Ramp = { fromS: number; toS: number; speed: number };
export type Segment = { fromS: number; toS: number; speed: number };

/** Real seconds kept at normal speed at each end of a ramped wait. */
export const RAMP_KEEP_HEAD_S = 1.2;
export const RAMP_KEEP_TAIL_S = 1;
/** A wait shorter than this is not worth ramping. */
export const RAMP_MIN_S = 6;

/** One ramp per beat that asks for one and waited long enough. */
export function planRamps(defs: readonly DevBeat[], beats: readonly RecordedBeat[]): Ramp[] {
	const ramps: Ramp[] = [];
	for (const def of defs) {
		if (!def.ramp || def.ramp <= 1) continue;
		const b = beats.find((x) => x.id === def.id);
		if (!b) continue;
		const fromS = round(b.startS + RAMP_KEEP_HEAD_S);
		const toS = round(b.readyS - RAMP_KEEP_TAIL_S);
		if (toS - fromS >= RAMP_MIN_S) ramps.push({ fromS, toS, speed: def.ramp });
	}
	return ramps;
}

/** Covers [0, totalS] with ramps and speed-1 gaps, in order. Overlapping ramps are rejected. */
export function buildSegments(totalS: number, ramps: readonly Ramp[]): Segment[] {
	const sorted = [...ramps].sort((a, b) => a.fromS - b.fromS);
	const out: Segment[] = [];
	let at = 0;
	for (const r of sorted) {
		if (r.fromS < at) throw new Error(`ramp ${r.fromS}-${r.toS} overlaps the previous one`);
		const toS = Math.min(r.toS, totalS);
		if (toS <= r.fromS) continue;
		if (r.fromS > at) out.push({ fromS: at, toS: r.fromS, speed: 1 });
		out.push({ fromS: r.fromS, toS, speed: r.speed });
		at = toS;
	}
	if (at < totalS) out.push({ fromS: at, toS: totalS, speed: 1 });
	return out;
}

export function outputDuration(segments: readonly Segment[]): number {
	return round(segments.reduce((sum, s) => sum + (s.toS - s.fromS) / s.speed, 0));
}

/** Where real second `realS` lands on the output clock. */
export function outputTime(segments: readonly Segment[], realS: number): number {
	let out = 0;
	for (const s of segments) {
		if (realS <= s.fromS) break;
		out += (Math.min(realS, s.toS) - s.fromS) / s.speed;
	}
	return round(out);
}

export type CaptionSpan = { text: string; fromS: number; toS: number | null };

/** A caption runs from its beat's action to the next beat's action; the last one to the end. Output seconds. */
export function captionSpans(
	defs: readonly DevBeat[],
	beats: readonly RecordedBeat[],
	segments: readonly Segment[]
): CaptionSpan[] {
	const shown = defs.filter((d) => d.caption && beats.some((b) => b.id === d.id));
	return shown.map((d, i) => {
		const b = beats.find((x) => x.id === d.id) as RecordedBeat;
		const next = shown[i + 1];
		const nb = next ? beats.find((x) => x.id === next.id) : undefined;
		return {
			text: d.caption,
			fromS: outputTime(segments, b.readyS),
			toS: nb ? outputTime(segments, nb.readyS) : null,
		};
	});
}

/** Output-time windows of the ramps, for the speed tag. */
export function rampSpans(segments: readonly Segment[]): { fromS: number; toS: number; speed: number }[] {
	return segments
		.filter((s) => s.speed !== 1)
		.map((s) => ({ fromS: outputTime(segments, s.fromS), toS: outputTime(segments, s.toS), speed: s.speed }));
}

/** True when every row-joined frame matches the beat's `waitScreen` (absent = always). */
export function screenMatches(source: string | undefined, frame: readonly string[]): boolean {
	return source === undefined || new RegExp(source, "m").test(frame.join("\n"));
}

const ALT_SCREEN_EXIT = "\u001b[?1049l";

/**
 * Cuts the PTY chunks where the dashboard leaves the alt screen: what follows is a blank normal screen, so the reel
 * ends on the dashboard's last frame. Returns the kept chunks and the second of the cut (null = never left).
 */
export function cutAtAltScreenExit(chunks: readonly Chunk[]): { kept: Chunk[]; exitS: number | null } {
	const i = chunks.findIndex((c) => c.data.includes(ALT_SCREEN_EXIT));
	if (i < 0) return { kept: [...chunks], exitS: null };
	const hit = chunks[i] as Chunk;
	const before = hit.data.slice(0, hit.data.indexOf(ALT_SCREEN_EXIT));
	return { kept: [...chunks.slice(0, i), ...(before ? [{ atS: hit.atS, data: before }] : [])], exitS: hit.atS };
}

type LsLease = { id: string; label?: string; pid?: number; resource: { kind: string; id?: string; port?: number } };

/** The device lease `warden dev --label <label>` holds, from `warden ls --json`; undefined until it exists. */
export function deviceLeaseOf(stdout: string, label: string): { leaseId: string; udid: string } | undefined {
	const doc = JSON.parse(stdout) as { leases: LsLease[] };
	// a queued claim is `pending:<name>` until the simulator exists: not a udid yet
	const l = doc.leases.find(
		(x) => x.label === label && x.resource.kind === "device" && x.resource.id && !x.resource.id.startsWith("pending:")
	);
	return l ? { leaseId: l.id, udid: l.resource.id as string } : undefined;
}

/** Leases still held by this session: its labelled device or any lease owned by the dev process `pid`. */
export function leasesHeldBy(stdout: string, label: string, pid: number): string[] {
	const doc = JSON.parse(stdout) as { leases: LsLease[] };
	return doc.leases.filter((l) => l.label === label || l.pid === pid).map((l) => l.id);
}
