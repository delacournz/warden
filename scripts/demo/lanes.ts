/**
 * Pure parts of the multi-lane reel (`warden dev` in several worktrees at once): the layout (one row per lane with the
 * real TUI card left and the real simulator right, a shell strip below), the shared clock the takes are lined up on,
 * the captions and the ffmpeg filtergraph. Side effects live in `lanes-demo.ts`.
 */
import { join } from "node:path";
import type { DevTake, LanesCaption } from "./demo.types";
import { fitBox } from "./dev-render";

export type Box = { x: number; y: number; w: number; h: number };
export type LaneRow = { card: Box; tui: Box; phone: Box & { radius: number } };
export type LanesLayout = {
	width: number;
	height: number;
	margin: number;
	titleBar: number;
	rows: LaneRow[];
	shell: { card: Box; box: Box };
	footerY: number;
};

const WIDTH = 1920;
const HEIGHT = 1080;
const MARGIN = 48;
const TITLE_BAR = 44;
const GAP = 20;
const TOP = 40;
const PHONE_ASPECT = 451 / 980;
const SHELL_MAX_H = 120;
const FOOTER = 74;
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * Fixed 1920x1080: the lanes' terminal cards stacked on the left, one tall phone per lane side by side to their right
 * (the pair centred on the canvas), the shell strip across the bottom. `shellAspect` and `tuiAspect` are the shell
 * gif's and a lane gif's width / height.
 */
export function lanesLayout(count: number, shellAspect: number, tuiAspect = 1.85): LanesLayout {
	const shellW = WIDTH - 2 * MARGIN - 40;
	const shellBox = fitBox({ x: 0, y: 0, w: shellW, h: SHELL_MAX_H }, shellAspect);
	const shellCardH = TITLE_BAR + 28 + shellBox.h;
	const bodyH = HEIGHT - TOP - shellCardH - GAP - FOOTER;
	const rowH = Math.floor((bodyH - (count - 1) * GAP) / count);
	const tuiH = rowH - TITLE_BAR - 28;
	const cardW = even(tuiH * tuiAspect) + 40;
	const phoneH = even(bodyH);
	const phoneW = even(phoneH * PHONE_ASPECT);
	const phonesW = count * phoneW + (count - 1) * 30;
	const groupW = cardW + 40 + phonesW;
	const left = Math.floor((WIDTH - groupW) / 2);
	const rows: LaneRow[] = Array.from({ length: count }, (_, i) => {
		const y = TOP + i * (rowH + GAP);
		const card = { x: left, y, w: cardW, h: rowH };
		return {
			card,
			tui: { x: card.x + 20, y: y + TITLE_BAR + 14, w: card.w - 40, h: tuiH },
			phone: { x: left + cardW + 40 + i * (phoneW + 30), y: TOP, w: phoneW, h: phoneH, radius: 48 },
		};
	});
	const shellY = TOP + bodyH + GAP;
	const card = { x: MARGIN, y: shellY, w: WIDTH - 2 * MARGIN, h: shellCardH };
	const box = {
		x: card.x + Math.floor((card.w - shellBox.w) / 2),
		y: shellY + TITLE_BAR + 14,
		w: shellBox.w,
		h: shellBox.h,
	};
	return {
		width: WIDTH,
		height: HEIGHT,
		margin: MARGIN,
		titleBar: TITLE_BAR,
		rows,
		shell: { card, box },
		footerY: card.y + card.h + 18,
	};
}

export type Aligned = {
	lanes: { tuiOffS: number; phoneOffS: number; endS: number }[];
	shellOffS: number;
	/** Master second at which every lane has reached the meet beat. */
	meetS: number;
	totalS: number;
};

/** Puts the takes and the shell clip on the clock of the earliest `startedAtS`. */
export function alignLanes(
	takes: readonly DevTake[],
	shell: { startedAtS: number; durationS: number },
	meetBeat = "client"
): Aligned {
	const origin = Math.min(shell.startedAtS, ...takes.map((t) => t.startedAtS));
	const lanes = takes.map((t) => {
		const off = t.startedAtS - origin;
		return { tuiOffS: off, phoneOffS: off + t.videoStartS, endS: off + t.recordedS };
	});
	const meets = takes.map((t, i) => {
		const beat = t.beats.find((b) => b.id === meetBeat);
		if (!beat) throw new Error(`take ${i} has no "${meetBeat}" beat`);
		return (lanes[i]?.tuiOffS ?? 0) + beat.readyS;
	});
	const shellOffS = shell.startedAtS - origin;
	return {
		lanes,
		shellOffS,
		meetS: Math.max(...meets),
		totalS: Math.max(...lanes.map((l) => l.endS), shellOffS + shell.durationS),
	};
}

export type CaptionSpan = { text: string; fromS: number; toS: number | null };

export function captionSpansLanes(
	captions: readonly LanesCaption[],
	at: { meetS: number; shellOffS: number; totalS: number }
): CaptionSpan[] {
	const from = (c: LanesCaption) => (c.at === "start" ? 0 : c.at === "meet" ? at.meetS : at.shellOffS);
	return captions.map((c, i) => {
		const next = captions[i + 1];
		return { text: c.text, fromS: from(c), toS: next ? from(next) : null };
	});
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const FPS = 30;

export type LanesFiltergraphOptions = {
	layout: LanesLayout;
	aligned: Aligned;
	/** Fitted gif box per lane (inside `layout.rows[i].tui`). */
	tuiBoxes: readonly Box[];
	captions: readonly CaptionSpan[];
	hold: number;
	monoFont: string;
	workDir: string;
};

/**
 * Inputs: 0 underlay (looped), 1..n the phone videos, n+1..2n the lane gifs, 2n+1 the shell gif, 2n+2 the phone mask
 * (looped). Every source is padded at the start by its offset on the shared clock and cloned at the end, so a lane
 * that quit earlier holds its last frame.
 */
export function buildLanesFiltergraph(o: LanesFiltergraphOptions): {
	graph: string;
	texts: { name: string; text: string }[];
} {
	const { layout, aligned } = o;
	const n = layout.rows.length;
	const total = aligned.totalS + o.hold;
	const pad = `stop_mode=clone:stop_duration=${total}`;
	const chains: string[] = [];
	const maskSplit = Array.from({ length: n }, (_, i) => `[m${i}]`).join("");
	chains.push(n === 1 ? "[MASK:v]format=gray[m0]" : `[MASK:v]format=gray,split=${n}${maskSplit}`);
	let last = "bg";
	chains.push(`[0:v]trim=duration=${total},setpts=PTS-STARTPTS[bg]`);
	const overlay = (src: string, x: number, y: number, tag: string) => {
		chains.push(`[${last}][${src}]overlay=${x}:${y}:eof_action=pass[${tag}]`);
		last = tag;
	};
	layout.rows.forEach((row, i) => {
		const lane = aligned.lanes[i];
		const box = o.tuiBoxes[i];
		if (!lane || !box) throw new Error(`lane ${i} missing`);
		chains.push(
			`[${1 + i}:v]fps=${FPS},scale=${row.phone.w}:${row.phone.h}:flags=lanczos,setsar=1,format=rgba,tpad=start_duration=${lane.phoneOffS}:start_mode=add:color=black:${pad}[pv${i}]`
		);
		chains.push(`[pv${i}][m${i}]alphamerge[pm${i}]`);
		chains.push(
			`[${1 + n + i}:v]fps=${FPS},scale=${box.w}:${box.h}:flags=lanczos,setsar=1,format=rgba,tpad=start_duration=${lane.tuiOffS}:start_mode=add:color=0x171715:${pad}[tv${i}]`
		);
		overlay(`pm${i}`, row.phone.x, row.phone.y, `o${i}p`);
		overlay(`tv${i}`, box.x, box.y, `o${i}t`);
	});
	const sb = layout.shell.box;
	chains.push(
		`[${1 + 2 * n}:v]fps=${FPS},scale=${sb.w}:${sb.h}:flags=lanczos,setsar=1,format=rgba,tpad=start_duration=${aligned.shellOffS}:start_mode=add:color=0x171715:${pad}[sv]`
	);
	overlay("sv", sb.x, sb.y, "osh");

	const texts: { name: string; text: string }[] = [];
	const draws = o.captions.map((c) => {
		const name = `t${texts.length}.txt`;
		texts.push({ name, text: c.text });
		const en = c.toS == null ? `gte(t,${c.fromS})` : `between(t,${c.fromS},${c.toS})`;
		return `drawtext=fontfile=${quote(o.monoFont)}:textfile=${quote(join(o.workDir, name))}:expansion=none:fontsize=22:fontcolor=0xf3f1ea:x=${layout.margin}:y=${layout.footerY - 2}:enable=${quote(en)}`;
	});
	chains.push(`[${last}]${[...draws, `fps=${FPS}`, `tpad=${pad}`, "format=yuv420p"].join(",")}[out]`);
	return { graph: chains.join(";\n").replaceAll("[MASK:v]", `[${2 * n + 2}:v]`), texts };
}
