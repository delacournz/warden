#!/usr/bin/env bun
/**
 * Demo compositor: turns a `warden batch --record <dir>` record dir into the
 * landing-page video. Five phone recordings side by side, per-phone flow
 * labels, a pass counter and warden's own TUI underneath, speed-ramped to
 * ~45 s with a hold on the final all-green frame.
 *
 *   bun scripts/demo/compose.ts <record-dir> <out-dir> [--duration 45] [--width 1920] [--hold 3]
 *
 * Writes demo.mp4 (h264, faststart, ≤6 MB), demo.webm (vp9) and poster.jpg.
 * Needs ffmpeg, ffprobe and agg (`brew install agg`).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ok, type Result } from "@delacour/warden-types/result";
import { type Batch, parseBatch } from "./batch";
import { computeLayout, type Layout, palette, renderTopLayer, renderUnderlay } from "./layout";

export type Tone = "ink" | "ink2" | "lease" | "fail";

/** A text shown over an output-time window; `to: null` means until the end. */
export type Span = { text: string; tone: Tone; from: number; to: number | null };

export type Label = Span & { worker: string };

export type Timeline = {
	/** Real seconds from the first recording frame to the end of the last job (+ tail). */
	realDuration: number;
	/** Output seconds per real second (≤ 1). */
	speed: number;
	outDuration: number;
	hold: number;
	total: number;
	phones: { worker: string; name: string; video: string; offset: number }[];
	/** Real seconds from the first recording frame to the cast's t=0 (batch start). */
	castOffset: number;
	labels: Label[];
	counter: Span[];
};

export type TimelineOptions = { duration: number; hold: number; tailMs?: number };

const round = (n: number, digits = 3) => Number(n.toFixed(digits));

/** Map a record dir's batch.json onto the output clock. Pure. */
export function buildTimeline(batch: Batch, opts: TimelineOptions): Timeline {
	const t0 = Math.min(...batch.devices.map((d) => d.videoStartedAt));
	const lastEnd = Math.max(t0, ...batch.jobs.map((j) => j.endedAt));
	const realDuration = (lastEnd + (opts.tailMs ?? 1000) - t0) / 1000;
	const speed = Math.min(1, (opts.duration - opts.hold) / realDuration);
	const at = (ms: number) => round(((Math.max(ms, t0) - t0) / 1000) * speed);

	const labels: Label[] = batch.devices.flatMap((d) => {
		const mine = batch.jobs.filter((j) => j.worker === d.worker).sort((a, b) => a.startedAt - b.startedAt);
		return mine.flatMap((j, i): Label[] => {
			const next = mine[i + 1];
			const pass = j.exitCode === 0;
			return [
				{
					worker: d.worker,
					text: j.attempt > 0 ? `${j.job} (retry)` : j.job,
					tone: "ink",
					from: at(j.startedAt),
					to: at(j.endedAt),
				},
				{
					worker: d.worker,
					text: `${pass ? "✓" : "✗"} ${j.job}`,
					tone: pass ? "lease" : "fail",
					from: at(j.endedAt),
					to: next ? at(next.startedAt) : null,
				},
			];
		});
	});

	const firstPass = new Map<string, number>();
	for (const j of batch.jobs) {
		if (j.exitCode !== 0) continue;
		const prev = firstPass.get(j.job);
		if (prev === undefined || j.endedAt < prev) firstPass.set(j.job, j.endedAt);
	}
	const total = new Set(batch.jobs.map((j) => j.job)).size;
	const passes = [...firstPass.values()].sort((a, b) => a - b).map(at);
	const counter: Span[] = [0, ...passes].map((from, n) => ({
		text: `${n}/${total} passed`,
		tone: n === total && total > 0 ? "lease" : "ink",
		from,
		to: passes[n] ?? null,
	}));

	return {
		realDuration: round(realDuration),
		speed: round(speed, 6),
		outDuration: round(realDuration * speed),
		hold: opts.hold,
		total,
		phones: batch.devices.map((d) => ({
			worker: d.worker,
			name: d.name,
			video: d.video,
			offset: round((d.videoStartedAt - t0) / 1000),
		})),
		castOffset: round((batch.startedAt - t0) / 1000),
		labels,
		counter,
	};
}

export type FiltergraphOptions = {
	layout: Layout;
	font: string;
	fps: number;
	workDir: string;
	/** Absolute recording paths, in `timeline.phones` order. */
	videos: string[];
	gif: string;
	output: string;
};

export type Filtergraph = {
	/** ffmpeg argv (without the binary). Expects `graph` at <workDir>/graph.txt and each text file in workDir. */
	args: string[];
	graph: string;
	texts: { name: string; text: string }[];
	underlay: string;
	top: string;
};

const toneColor: Record<Tone, string> = {
	ink: palette.ink,
	ink2: palette.ink2,
	lease: palette.lease,
	fail: palette.fail,
};

/** First-level filtergraph quoting; the option parser then sees the bare value. */
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function enable(span: { from: number; to: number | null }): string {
	return span.to === null ? `gte(t,${span.from})` : `between(t,${span.from},${span.to})`;
}

/**
 * Align, ramp and hold one clip. `offset` is real seconds of lead-in (negative: skip).
 * The early `fps` gives VFR sources (simctl recordings, gifs) a frame rate: tpad
 * silently stops padding without one, and a trailing `stop=-1` never reaches EOF.
 */
function alignChain(offset: number, realDuration: number, speed: number, fps: number): string[] {
	const lead = offset < 0 ? [`trim=start=${-offset}`, "setpts=PTS-STARTPTS"] : ["setpts=PTS-STARTPTS"];
	const start = offset > 0 ? `start_duration=${offset}:start_mode=clone:` : "";
	return [
		...lead,
		`fps=${fps}`,
		`tpad=${start}stop_duration=${realDuration}:stop_mode=clone`,
		`trim=duration=${realDuration}`,
		`setpts=(PTS-STARTPTS)*${speed}`,
		`fps=${fps}`,
	];
}

/** The whole composite as one ffmpeg invocation. Pure: callers write the layers, graph and texts. */
export function buildFiltergraph(tl: Timeline, opts: FiltergraphOptions): Filtergraph {
	const { layout, fps, workDir } = opts;
	const underlay = join(workDir, "underlay.png");
	const top = join(workDir, "top.png");
	const n = tl.phones.length;
	const gifIn = n + 1;
	const topIn = n + 2;
	const chains: string[] = [];

	chains.push(`[0:v]trim=duration=${tl.outDuration},setpts=PTS-STARTPTS[bg0]`);
	tl.phones.forEach((p, i) => {
		const slot = layout.phones[i];
		if (!slot) throw new Error(`layout has no slot for phone ${i}`);
		const steps = [
			`scale=${slot.screen.w}:${slot.screen.h}:flags=lanczos`,
			"setsar=1",
			...alignChain(p.offset, tl.realDuration, tl.speed, fps),
		];
		chains.push(`[${i + 1}:v]${steps.join(",")}[p${i}]`);
		chains.push(`[bg${i}][p${i}]overlay=x=${slot.screen.x}:y=${slot.screen.y}[bg${i + 1}]`);
	});
	const term = layout.terminal;
	const termSteps = [
		...alignChain(tl.castOffset, tl.realDuration, tl.speed, fps),
		`scale=${term.w}:${term.h}:flags=lanczos`,
		"setsar=1",
	];
	chains.push(`[${gifIn}:v]${termSteps.join(",")}[term]`);
	chains.push(`[bg${n}][term]overlay=x=${term.x}:y=${term.y}[bgt]`);
	chains.push(`[bgt][${topIn}:v]overlay=0:0:shortest=1[comp]`);

	const texts: Filtergraph["texts"] = [];
	const draws: string[] = [];
	const draw = (text: string, o: { size: number; tone: Tone; x: string; y: number; span?: Span; expand?: boolean }) => {
		const name = `t${texts.length}.txt`;
		texts.push({ name, text });
		const parts = [
			`fontfile=${quote(opts.font)}`,
			`textfile=${quote(join(workDir, name))}`,
			`expansion=${o.expand ? "normal" : "none"}`,
			`fontsize=${o.size}`,
			`fontcolor=0x${toneColor[o.tone]}`,
			`x=${o.x}`,
			`y=${o.y}`,
		];
		if (o.span) parts.push(`enable=${quote(enable(o.span))}`);
		draws.push(`drawtext=${parts.join(":")}`);
	};

	const flows = tl.total === 1 ? "flow" : "flows";
	const sims = n === 1 ? "sim" : "sims";
	draw(`warden batch ios · ${n} ${sims} · ${tl.total} ${flows}`, {
		size: layout.headerSize,
		tone: "ink",
		x: `${layout.margin}`,
		y: layout.headerY,
	});
	const clamp = `min(t,${tl.outDuration})/${tl.speed}`;
	draw(`%{eif:trunc(${clamp}/60):d:2}:%{eif:mod(trunc(${clamp}),60):d:2} elapsed`, {
		size: layout.headerSize,
		tone: "ink2",
		x: "(w-text_w)/2",
		y: layout.headerY,
		expand: true,
	});
	for (const c of tl.counter) {
		draw(c.text, { size: layout.headerSize, tone: c.tone, x: `w-${layout.margin}-text_w`, y: layout.headerY, span: c });
	}
	tl.phones.forEach((p, i) => {
		const slot = layout.phones[i];
		if (!slot) return;
		const cx = `${slot.labelX}-text_w/2`;
		draw(p.name, { size: layout.nameSize, tone: "ink2", x: cx, y: slot.nameY });
		for (const l of tl.labels.filter((x) => x.worker === p.worker)) {
			draw(l.text, { size: layout.jobSize, tone: l.tone, x: cx, y: slot.jobY, span: l });
		}
	});

	const tail = [...draws, `fps=${fps}`, `tpad=stop_mode=clone:stop_duration=${tl.hold}`, "format=yuv420p"];
	chains.push(`[comp]${tail.join(",")}[out]`);
	const graph = chains.join(";\n");

	const loop = ["-loop", "1", "-framerate", `${fps}`];
	const args = [
		"-nostdin",
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		"-stats",
		...loop,
		"-i",
		underlay,
		...opts.videos.flatMap((v) => ["-i", v]),
		"-i",
		opts.gif,
		...loop,
		"-i",
		top,
		"-/filter_complex",
		join(workDir, "graph.txt"),
		"-map",
		"[out]",
		"-an",
		"-r",
		`${fps}`,
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"12",
		"-pix_fmt",
		"yuv420p",
		opts.output,
	];
	return { args, graph, texts, underlay, top };
}

/** Real ms kept after the last job, so the final ✓ and n/n counter are on screen before the hold. */
const TAIL_MS = 2500;

const quiet = ["-nostdin", "-y", "-hide_banner", "-loglevel", "error"];

export function mp4Args(input: string, output: string, crf: number): string[] {
	return [
		...quiet,
		"-i",
		input,
		"-an",
		"-c:v",
		"libx264",
		"-preset",
		"slow",
		"-tune",
		"animation",
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

export function webmArgs(input: string, output: string, crf = 40): string[] {
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

/** The last second is inside the hold, i.e. the final all-green frame. */
export function posterArgs(input: string, output: string): string[] {
	return [
		"-nostdin",
		"-y",
		"-sseof",
		"-1",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		input,
		"-frames:v",
		"1",
		"-q:v",
		"2",
		output,
	];
}

/** Next CRF to try when `bytes` is over budget, or null when done (fits, or quality floor reached). */
export function nextCrf(bytes: number, crf: number, maxBytes: number): number | null {
	if (bytes <= maxBytes) return null;
	const next = crf + 3;
	return next > 44 ? null : next;
}

export type ComposeOptions = {
	recordDir: string;
	outDir: string;
	duration: number;
	width: number;
	hold: number;
	maxBytes: number;
};

const usage = "usage: bun scripts/demo/compose.ts <record-dir> <out-dir> [--duration 45] [--width 1920] [--hold 3]";

export function parseCli(argv: string[]): Result<ComposeOptions> {
	let parsed: ReturnType<typeof parseArgs<{ options: Record<string, { type: "string" }>; allowPositionals: true }>>;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: { duration: { type: "string" }, width: { type: "string" }, hold: { type: "string" } },
		});
	} catch (e) {
		return { success: false, error: `${e instanceof Error ? e.message : String(e)}\n${usage}` };
	}
	const [recordDir, outDir] = parsed.positionals;
	if (!recordDir || !outDir) return { success: false, error: usage };
	const numbers: Record<"duration" | "width" | "hold", number> = { duration: 45, width: 1920, hold: 3 };
	for (const key of ["duration", "width", "hold"] as const) {
		const raw = parsed.values[key];
		if (raw === undefined) continue;
		const v = Number(raw);
		if (!Number.isFinite(v) || v <= 0) return { success: false, error: `--${key} must be a positive number\n${usage}` };
		numbers[key] = v;
	}
	if (numbers.hold >= numbers.duration) return { success: false, error: "--hold must be shorter than --duration" };
	return ok({ recordDir, outDir, ...numbers, maxBytes: 6_000_000 });
}

const fontCandidates = ["/System/Library/Fonts/Menlo.ttc", "/Library/Fonts/Arial Unicode.ttf"];

async function run(cmd: string[], label: string): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) throw new Error(`${label} failed (exit ${code}): ${cmd.join(" ")}`);
	return out;
}

async function probeSize(file: string): Promise<{ w: number; h: number }> {
	const out = await run(
		[
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height",
			"-of",
			"csv=p=0:s=x",
			file,
		],
		"ffprobe"
	);
	const [w, h] = out.trim().split("x").map(Number);
	if (!w || !h) throw new Error(`ffprobe: no video size for ${file}`);
	return { w, h };
}

async function writePng(rgba: Uint8Array, layout: Layout, rawPath: string, pngPath: string): Promise<void> {
	await writeFile(rawPath, rgba);
	await run(
		[
			"ffmpeg",
			...quiet,
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			"-s",
			`${layout.width}x${layout.height}`,
			"-i",
			rawPath,
			"-frames:v",
			"1",
			pngPath,
		],
		"ffmpeg png"
	);
}

/** agg theme: bg, fg, then the 8 ANSI colours, all from the docs dark tokens. */
const aggTheme = [
	palette.surface,
	palette.ink,
	palette.fill,
	palette.fail,
	palette.lease,
	"ffd60a",
	"0a84ff",
	"bf5af2",
	"64d2ff",
	palette.ink,
].join(",");

async function compose(o: ComposeOptions): Promise<void> {
	for (const bin of ["ffmpeg", "ffprobe"]) {
		if (!Bun.which(bin)) throw new Error(`${bin} not found — brew install ffmpeg`);
	}
	if (!Bun.which("agg")) throw new Error("agg not found — brew install agg");
	const font = fontCandidates.find((f) => existsSync(f));
	if (!font) throw new Error(`no label font found (tried ${fontCandidates.join(", ")})`);

	const recordDir = resolve(o.recordDir);
	const outDir = resolve(o.outDir);
	const parsed = parseBatch(JSON.parse(await readFile(join(recordDir, "batch.json"), "utf8")));
	if (!parsed.success) throw new Error(parsed.error);
	const batch = parsed.data;
	const videos = batch.devices.map((d) => join(recordDir, d.video));
	const cast = join(recordDir, "tui.cast");
	for (const f of [...videos, cast]) if (!existsSync(f)) throw new Error(`missing ${f}`);

	await mkdir(outDir, { recursive: true });
	const workDir = await mkdtemp(join(tmpdir(), "warden-demo-"));
	try {
		const gif = join(workDir, "tui.gif");
		console.error("agg: rendering tui.cast");
		await run(
			[
				"agg",
				"-q",
				"--theme",
				aggTheme,
				"--font-size",
				"20",
				"--idle-time-limit",
				"86400",
				"--last-frame-duration",
				"1",
				"--no-loop",
				cast,
				gif,
			],
			"agg"
		);
		const phone = await probeSize(videos[0] ?? "");
		const termSize = await probeSize(gif);
		const layout = computeLayout({
			width: o.width,
			phones: batch.devices.length,
			phoneAspect: phone.w / phone.h,
			terminalAspect: termSize.w / termSize.h,
		});
		const tl = buildTimeline(batch, { duration: o.duration, hold: o.hold, tailMs: TAIL_MS });
		const inter = join(workDir, "inter.mp4");
		const fg = buildFiltergraph(tl, { layout, font, fps: 30, workDir, videos, gif, output: inter });
		await writePng(renderUnderlay(layout), layout, join(workDir, "underlay.rgba"), fg.underlay);
		await writePng(renderTopLayer(layout), layout, join(workDir, "top.rgba"), fg.top);
		await writeFile(join(workDir, "graph.txt"), fg.graph);
		await Promise.all(fg.texts.map((t) => writeFile(join(workDir, t.name), t.text)));

		console.error(
			`compose: ${layout.width}x${layout.height}, ${tl.realDuration}s real → ${tl.outDuration}s (+${tl.hold}s hold), ${batch.devices.length} phones`
		);
		await run(["ffmpeg", ...fg.args], "ffmpeg compose");

		const mp4 = join(outDir, "demo.mp4");
		let crf = 26;
		for (;;) {
			await run(["ffmpeg", ...mp4Args(inter, mp4, crf)], "ffmpeg mp4");
			const bytes = (await stat(mp4)).size;
			console.error(`mp4: crf ${crf} → ${(bytes / 1e6).toFixed(2)} MB`);
			const next = nextCrf(bytes, crf, o.maxBytes);
			if (next === null) {
				if (bytes > o.maxBytes) console.error(`warning: demo.mp4 is over ${o.maxBytes / 1e6} MB at crf ${crf}`);
				break;
			}
			crf = next;
		}
		const webm = join(outDir, "demo.webm");
		await run(["ffmpeg", ...webmArgs(inter, webm)], "ffmpeg webm");
		console.error(`webm: ${((await stat(webm)).size / 1e6).toFixed(2)} MB`);
		await run(["ffmpeg", ...posterArgs(inter, join(outDir, "poster.jpg"))], "ffmpeg poster");
		console.error(`wrote ${mp4}, ${webm}, ${join(outDir, "poster.jpg")}`);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const cli = parseCli(Bun.argv.slice(2));
	if (!cli.success) {
		console.error(cli.error);
		process.exit(2);
	}
	compose(cli.data).catch((e: unknown) => {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	});
}
