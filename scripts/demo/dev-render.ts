#!/usr/bin/env bun
/**
 * Renders a `warden dev` take (take.mp4 + tui.cast + dev.json from `dev-take.ts`) into the reel:
 * the real TUI (agg, Martian Mono, docs dark palette) on the left in a terminal card, the real simulator video on
 * the right, captions under the card, and a visible "× speed" tag over every sped-up stretch. Only waits flagged
 * `ramp` in the definition are sped up; keys and the hot reload run in real time.
 *
 * Writes <name>.mp4 (h264 faststart yuv420p 30 fps, <= 6 MB), .webm and a poster .jpg, plus sheet.jpg on request.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DevDemoDefinition, DevTake } from "./demo.types";
import {
	buildSegments,
	captionSpans,
	outputDuration,
	outputTime,
	planRamps,
	rampSpans,
	type Segment,
} from "./dev-timeline";

export const CANVAS = { width: 1920, height: 1080, fps: 30 } as const;
const MARGIN = 48;
const TITLE_BAR = 44;
export const DEV_LAYOUT = {
	card: { x: MARGIN, y: 50, w: 1300, h: 980 },
	phone: { x: 1400, y: 50, w: 451, h: 980, radius: 62 },
	titleBar: TITLE_BAR,
	/** Where the agg gif is fitted (inside the card, under the title bar). */
	tui: { x: MARGIN + 20, y: 50 + TITLE_BAR + 14, w: 1260, h: 980 - TITLE_BAR - 28 },
	footerY: 1046,
} as const;

/** Largest size with the gif's aspect that fits the box, even-sized, centred in it. */
export function fitBox(box: { x: number; y: number; w: number; h: number }, aspect: number) {
	const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
	let w = even(box.w);
	let h = even(w / aspect);
	if (h > box.h) {
		h = even(box.h);
		w = even(h * aspect);
	}
	return { x: box.x + Math.floor((box.w - w) / 2), y: box.y + Math.floor((box.h - h) / 2), w, h };
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Retime one clip through the segments: trim each, scale its time by the speed, concat. */
function retime(label: string, input: string, segments: readonly Segment[], out: string): string[] {
	const n = segments.length;
	const split =
		n === 1 ? `[${input}]null[${label}0]` : `[${input}]split=${n}${segments.map((_, i) => `[${label}s${i}]`).join("")}`;
	const parts = segments.map((s, i) => {
		const src = n === 1 ? `${label}0` : `${label}s${i}`;
		return `[${src}]trim=start=${s.fromS}:end=${s.toS},setpts=(PTS-STARTPTS)/${s.speed},fps=${CANVAS.fps}[${label}r${i}]`;
	});
	const concat = `${segments.map((_, i) => `[${label}r${i}]`).join("")}concat=n=${n}:v=1:a=0[${out}]`;
	return n === 1
		? [
				`[${input}]trim=start=${segments[0]?.fromS}:end=${segments[0]?.toS},setpts=PTS-STARTPTS,fps=${CANVAS.fps}[${out}]`,
			]
		: [split, ...parts, concat];
}

export type DevFiltergraph = { graph: string; texts: { name: string; text: string }[] };

export type DevFiltergraphOptions = {
	def: DevDemoDefinition;
	take: DevTake;
	segments: readonly Segment[];
	tuiBox: { x: number; y: number; w: number; h: number };
	/** Real seconds padded after the last frame of both clips so trims never run dry. */
	padS: number;
	hold: number;
	monoFont: string;
	workDir: string;
};

/** Inputs: 0 underlay (looped), 1 take.mp4, 2 tui.gif, 3 mask (looped). Pure; the caller writes graph + texts. */
export function buildDevFiltergraph(o: DevFiltergraphOptions): DevFiltergraph {
	const { def, take, segments } = o;
	const L = DEV_LAYOUT;
	const total = outputDuration(segments);
	const chains: string[] = [];
	chains.push(
		`[1:v]fps=${CANVAS.fps},scale=${L.phone.w}:${L.phone.h}:flags=lanczos,setsar=1,format=rgba,tpad=start_duration=${take.videoStartS}:start_mode=add:color=black:stop_mode=clone:stop_duration=${o.padS}[pv]`
	);
	chains.push(...retime("p", "pv", segments, "prr"));
	chains.push(`[prr]tpad=stop_mode=clone:stop_duration=${o.hold}[pr]`);
	chains.push("[3:v]format=gray[m]");
	chains.push("[pr][m]alphamerge[pm]");
	chains.push(
		`[2:v]fps=${CANVAS.fps},scale=${o.tuiBox.w}:${o.tuiBox.h}:flags=lanczos,setsar=1,format=rgba,tpad=stop_mode=clone:stop_duration=${o.padS}[tv]`
	);
	chains.push(...retime("t", "tv", segments, "trr"));
	chains.push(`[trr]tpad=stop_mode=clone:stop_duration=${o.hold}[tr]`);
	chains.push(`[0:v]trim=duration=${total + o.hold},setpts=PTS-STARTPTS[bg]`);
	chains.push(`[bg][pm]overlay=${L.phone.x}:${L.phone.y}:eof_action=pass[b1]`);
	chains.push(`[b1][tr]overlay=${o.tuiBox.x}:${o.tuiBox.y}:eof_action=pass[comp]`);

	const texts: DevFiltergraph["texts"] = [];
	const draws: string[] = [];
	const draw = (
		text: string,
		p: { size: number; color: string; x: string; y: number; from?: number; to?: number | null }
	) => {
		const name = `t${texts.length}.txt`;
		texts.push({ name, text });
		const parts = [
			`fontfile=${quote(o.monoFont)}`,
			`textfile=${quote(join(o.workDir, name))}`,
			"expansion=none",
			`fontsize=${p.size}`,
			`fontcolor=0x${p.color}`,
			`x=${p.x}`,
			`y=${p.y}`,
		];
		if (p.from !== undefined) {
			const en = p.to == null ? `gte(t,${p.from})` : `between(t,${p.from},${p.to})`;
			parts.push(`enable=${quote(en)}`);
		}
		draws.push(`drawtext=${parts.join(":")}`);
	};
	for (const c of captionSpans(def.beats, take.beats, segments)) {
		draw(c.text, { size: 22, color: "f3f1ea", x: `${MARGIN}`, y: L.footerY - 2, from: c.fromS, to: c.toS });
	}
	for (const r of rampSpans(segments)) {
		draw(`× ${r.speed} speed`, {
			size: 17,
			color: "ff6a3d",
			x: `${L.card.x + L.card.w}-24-text_w`,
			y: L.card.y + 13,
			from: r.fromS,
			to: r.toS,
		});
	}
	chains.push(
		`[comp]${[...draws, `fps=${CANVAS.fps}`, `tpad=stop_mode=clone:stop_duration=${o.hold}`, "format=yuv420p"].join(",")}[out]`
	);
	return { graph: chains.join(";\n"), texts };
}

export const quiet = ["-nostdin", "-y", "-hide_banner", "-loglevel", "error"];

export function mp4Args(input: string, output: string, crf: number): string[] {
	return [
		...quiet,
		"-i",
		input,
		"-an",
		"-r",
		`${CANVAS.fps}`,
		"-c:v",
		"libx264",
		"-preset",
		"slow",
		"-crf",
		`${crf}`,
		"-profile:v",
		"high",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		output,
	];
}

export function webmArgs(input: string, output: string, crf = 38): string[] {
	return [
		...quiet,
		"-i",
		input,
		"-an",
		"-c:v",
		"libvpx-vp9",
		"-crf",
		`${crf}`,
		"-b:v",
		"0",
		"-row-mt",
		"1",
		"-deadline",
		"good",
		"-cpu-used",
		"2",
		"-pix_fmt",
		"yuv420p",
		output,
	];
}

/** Docs dark palette as an agg theme: bg, fg, then the 8 ANSI colours. */
export const AGG_THEME = [
	"171715",
	"f3f1ea",
	"2c2c2e",
	"ff453a",
	"30d158",
	"ffd60a",
	"0a84ff",
	"bf5af2",
	"64d2ff",
	"f3f1ea",
].join(",");

export async function run(cmd: string[], label: string): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) throw new Error(`${label} failed (exit ${code}): ${cmd.join(" ")}`);
	return out;
}

export const probe = async (file: string, entries: string) =>
	(
		await run(
			["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "csv=p=0:s=x", file],
			"ffprobe"
		)
	).trim();

export type RenderOutputs = { mp4: string; webm: string; jpg: string; durationS: number; ramps: number };

export async function renderDev(
	def: DevDemoDefinition,
	take: DevTake,
	opts: { work: string; outDir: string; outName: string; repoRoot: string; sheet: boolean; maxBytes: number }
): Promise<RenderOutputs> {
	for (const bin of ["ffmpeg", "ffprobe", "agg", "uv"]) if (!Bun.which(bin)) throw new Error(`${bin} not found`);
	const { work } = opts;
	const fonts = join(opts.repoRoot, "node_modules/@expo-google-fonts");
	const monoDir = join(fonts, "martian-mono/400Regular");
	const monoFont = join(monoDir, "MartianMono_400Regular.ttf");
	const takePath = join(work, "take.mp4");
	const gif = join(work, "tui.gif");

	await run(
		[
			"agg",
			"-q",
			"--theme",
			AGG_THEME,
			"--font-dir",
			monoDir,
			"--text-font-family",
			"Martian Mono,Menlo,Apple Symbols,Arial Unicode MS",
			"--font-size",
			"20",
			"--line-height",
			"1.35",
			"--fps-cap",
			"30",
			"--idle-time-limit",
			"86400",
			"--last-frame-duration",
			"1",
			"--no-loop",
			join(work, "tui.cast"),
			gif,
		],
		"agg"
	);
	const [gw, gh] = (await probe(gif, "stream=width,height")).split("x").map(Number);
	if (!gw || !gh) throw new Error("agg produced no gif size");
	const tuiBox = fitBox(DEV_LAYOUT.tui, gw / gh);

	const totalS = take.recordedS;
	const ramps = planRamps(def.beats, take.beats);
	const segments = buildSegments(totalS, ramps);
	const fg = buildDevFiltergraph({ def, take, segments, tuiBox, padS: 5, hold: 1.5, monoFont, workDir: work });
	await writeFile(join(work, "graph.txt"), fg.graph);
	for (const t of fg.texts) await writeFile(join(work, t.name), t.text);

	const L = DEV_LAYOUT;
	const layoutJson = join(work, "layout.json");
	await writeFile(
		layoutJson,
		JSON.stringify({
			width: CANVAS.width,
			height: CANVAS.height,
			margin: MARGIN,
			monoFont,
			card: [L.card.x, L.card.y, L.card.w, L.card.h],
			titleBar: L.titleBar,
			phone: [L.phone.x, L.phone.y, L.phone.w, L.phone.h, L.phone.radius],
			terminalTitle: def.terminalTitle,
			footerLeft: "",
			footerRight: def.footer.right,
			footerY: L.footerY,
		})
	);
	const underlay = join(work, "underlay.png");
	const mask = join(work, "mask.png");
	await run(
		["uv", "run", "--script", join(import.meta.dir, "dev-frame.py"), layoutJson, underlay, mask],
		"dev-frame.py"
	);

	const total = outputDuration(segments) + 1.5;
	const inter = join(work, "inter.mp4");
	const loop = ["-loop", "1", "-framerate", `${CANVAS.fps}`];
	await run(
		[
			"ffmpeg",
			...quiet,
			"-stats",
			...loop,
			"-i",
			underlay,
			"-i",
			takePath,
			"-i",
			gif,
			...loop,
			"-i",
			mask,
			"-/filter_complex",
			join(work, "graph.txt"),
			"-map",
			"[out]",
			"-t",
			`${total}`,
			"-an",
			"-r",
			`${CANVAS.fps}`,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"12",
			"-pix_fmt",
			"yuv420p",
			inter,
		],
		"ffmpeg compose"
	);

	await mkdir(opts.outDir, { recursive: true });
	const mp4 = join(opts.outDir, `${opts.outName}.mp4`);
	const webm = join(opts.outDir, `${opts.outName}.webm`);
	const jpg = join(opts.outDir, `${opts.outName}.jpg`);
	let crf = 24;
	for (;;) {
		await run(["ffmpeg", ...mp4Args(inter, mp4, crf)], "ffmpeg mp4");
		const bytes = (await stat(mp4)).size;
		console.error(`mp4 crf ${crf}: ${(bytes / 1e6).toFixed(2)} MB`);
		if (bytes <= opts.maxBytes || crf >= 40) break;
		crf += 3;
	}
	await run(["ffmpeg", ...webmArgs(inter, webm)], "ffmpeg webm");
	const poster = take.beats.find((b) => b.id === def.posterBeat);
	if (!poster) throw new Error(`posterBeat "${def.posterBeat}" is not in the take`);
	const posterAt = outputTime(segments, poster.readyS) + 1;
	await run(
		["ffmpeg", ...quiet, "-ss", `${posterAt}`, "-i", mp4, "-frames:v", "1", "-q:v", "2", "-update", "1", jpg],
		"ffmpeg poster"
	);
	if (opts.sheet) {
		const font = "/System/Library/Fonts/Menlo.ttc";
		await run(
			[
				"ffmpeg",
				...quiet,
				"-i",
				mp4,
				"-vf",
				`fps=1,scale=480:-1,drawtext=fontfile=${font}:text='%{pts\\:hms}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x${Math.ceil(total / 4)}`,
				"-frames:v",
				"1",
				join(work, "sheet.jpg"),
			],
			"ffmpeg sheet"
		);
	}
	return { mp4, webm, jpg, durationS: total, ramps: ramps.length };
}
