#!/usr/bin/env bun
/**
 * `bun run demo:lanes <feature>/<clip> --worktrees <dir> [--record-only|--render-only] [--sheet] [--out dir]`
 *
 * Several `warden dev` sessions at once, one per git worktree under `<dir>` (`git worktree add --detach <dir>/<name> HEAD`
 * + `bun install` first), each with its own simulator and Metro port, then `warden ls` for real over all of them.
 * Definition `apps/example/demos/<feature>/<clip>.demo.ts` exports `demo: LanesDemoDefinition`. Records every lane with
 * `recordDev` in this one process (one clock), the shell command in a PTY, and renders the reel to
 * `apps/docs/public/demos/<feature>/<clip>.{mp4,webm,jpg}`. Needs ffmpeg, agg, uv.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DevTake, LanesDemoDefinition } from "./demo.types";
import { AGG_THEME, fitBox, mp4Args, probe, quiet, run, webmArgs } from "./dev-render";
import { recordDev } from "./dev-take";
import { type Chunk, castText } from "./dev-timeline";
import { alignLanes, buildLanesFiltergraph, captionSpansLanes, lanesLayout } from "./lanes";
import { demoPaths } from "./paths";
import { defaultDeps } from "./record";

const REPO = resolve(import.meta.dir, "../..");
const DEFAULT_SIMD = "/Users/chris/.warden/simd/0.6.0/warden-simd";
const TYPE_MS = 45;
const FPS = 30;

type ShellClip = { startedAtS: number; durationS: number; output: string };

/** The command typed after a prompt, then run for real under a PTY; its output is what the cast shows. */
async function recordShell(def: LanesDemoDefinition, outDir: string): Promise<ShellClip> {
	const { cols, rows, command } = def.shell;
	const startedAtS = defaultDeps.now();
	const at = () => defaultDeps.now() - startedAtS;
	const chunks: Chunk[] = [{ atS: 0, data: "\u001b[?25l\u001b[2m$\u001b[0m \u001b[?25h" }];
	await defaultDeps.sleep(500);
	for (const ch of command) {
		chunks.push({ atS: at(), data: ch });
		await defaultDeps.sleep(TYPE_MS);
	}
	await defaultDeps.sleep(300);
	chunks.push({ atS: at(), data: "\r\n" });
	const decoder = new TextDecoder();
	let output = "";
	const proc = Bun.spawn(["sh", "-c", command], {
		env: { ...process.env, TERM: "xterm-256color" },
		terminal: {
			cols,
			rows,
			data(_t, chunk) {
				const data = decoder.decode(new Uint8Array(chunk), { stream: true });
				output += data;
				chunks.push({ atS: at(), data });
			},
		},
	});
	const code = await proc.exited;
	if (code !== 0) throw new Error(`shell command exited ${code}: ${output}`);
	await defaultDeps.sleep(400);
	chunks.push({ atS: at(), data: "$ " });
	const durationS = at() + 0.5;
	chunks.push({ atS: durationS, data: "\u001b[?25l" });
	await writeFile(join(outDir, "shell.cast"), castText(chunks, cols, rows));
	return { startedAtS, durationS, output };
}

type Recorded = { takes: DevTake[]; shell: ShellClip };

async function recordLanes(def: LanesDemoDefinition, worktrees: string, work: string): Promise<Recorded> {
	let reached = 0;
	let open: () => void = () => undefined;
	let fail: (e: unknown) => void = () => undefined;
	const gate = new Promise<void>((resolveGate, rejectGate) => {
		open = resolveGate;
		fail = rejectGate;
	});
	gate.catch(() => undefined);
	let shell: ShellClip | undefined;
	const lanes = def.lanes.map(async (lane, i) => {
		try {
			return await recordLane(lane, i);
		} catch (e) {
			// a lane that failed would leave the others holding at the meet beat forever
			fail(e);
			throw e;
		}
	});
	async function recordLane(lane: LanesDemoDefinition["lanes"][number], i: number): Promise<DevTake> {
		await defaultDeps.sleep(i * def.staggerMs);
		const dir = join(worktrees, lane.checkout);
		if (!existsSync(join(dir, def.base.app.project))) throw new Error(`no worktree at ${dir}`);
		const out = join(work, `lane-${i}`);
		return recordDev(def.base, dir, out, lane.label, defaultDeps, {
			onBeat: async (beat) => {
				if (beat.id !== def.meetBeat) return;
				reached += 1;
				if (reached === def.lanes.length) {
					shell = await recordShell(def, work).catch((e: unknown) => {
						fail(e);
						throw e;
					});
					open();
				}
				await gate;
			},
		});
	}
	const settled = await Promise.allSettled(lanes);
	const failed = settled.find((s) => s.status === "rejected");
	if (failed?.status === "rejected") {
		fail(failed.reason);
		throw failed.reason;
	}
	if (!shell) throw new Error("the shell command never ran");
	return { takes: settled.map((s) => (s.status === "fulfilled" ? s.value : (undefined as never))), shell };
}

async function agg(cast: string, gif: string, monoDir: string): Promise<{ w: number; h: number }> {
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
			cast,
			gif,
		],
		"agg"
	);
	const [w, h] = (await probe(gif, "stream=width,height")).split("x").map(Number);
	if (!w || !h) throw new Error(`agg produced no size for ${cast}`);
	return { w, h };
}

async function render(
	def: LanesDemoDefinition,
	rec: Recorded,
	work: string,
	outDir: string,
	outName: string,
	sheet: boolean
): Promise<{ mp4: string; jpg: string; totalS: number }> {
	const monoDir = join(REPO, "node_modules/@expo-google-fonts/martian-mono/400Regular");
	const monoFont = join(monoDir, "MartianMono_400Regular.ttf");
	const n = def.lanes.length;
	const laneGifs = def.lanes.map((_, i) => join(work, `lane-${i}`, "tui.gif"));
	const sizes = await Promise.all(
		def.lanes.map((_, i) => agg(join(work, `lane-${i}`, "tui.cast"), laneGifs[i] ?? "", monoDir))
	);
	const shellGif = join(work, "shell.gif");
	const shellSize = await agg(join(work, "shell.cast"), shellGif, monoDir);
	const layout = lanesLayout(n, shellSize.w / shellSize.h, (sizes[0]?.w ?? 1) / (sizes[0]?.h ?? 1));
	const tuiBoxes = layout.rows.map((r, i) => fitBox(r.tui, (sizes[i]?.w ?? 1) / (sizes[i]?.h ?? 1)));
	const aligned = alignLanes(rec.takes, rec.shell, def.meetBeat);
	const hold = 1.5;
	const captions = captionSpansLanes(def.captions, aligned);
	const fg = buildLanesFiltergraph({ layout, aligned, tuiBoxes, captions, hold, monoFont, workDir: work });
	await writeFile(join(work, "graph.txt"), fg.graph);
	for (const t of fg.texts) await writeFile(join(work, t.name), t.text);
	await writeFile(
		join(work, "layout.json"),
		JSON.stringify({
			width: layout.width,
			height: layout.height,
			margin: layout.margin,
			monoFont,
			titleBar: layout.titleBar,
			rows: layout.rows.map((r, i) => ({
				card: [r.card.x, r.card.y, r.card.w, r.card.h],
				title: def.lanes[i]?.title ?? "",
				phone: [r.phone.x, r.phone.y, r.phone.w, r.phone.h, r.phone.radius],
			})),
			shell: {
				card: [layout.shell.card.x, layout.shell.card.y, layout.shell.card.w, layout.shell.card.h],
				title: def.shell.title,
			},
			footerRight: def.footer.right,
			footerY: layout.footerY,
		})
	);
	const underlay = join(work, "underlay.png");
	const mask = join(work, "mask.png");
	await run(
		["uv", "run", "--script", join(import.meta.dir, "lanes-frame.py"), join(work, "layout.json"), underlay, mask],
		"lanes-frame.py"
	);

	const total = aligned.totalS + hold;
	const inter = join(work, "inter.mp4");
	const loop = ["-loop", "1", "-framerate", `${FPS}`];
	const inputs = [
		...loop,
		"-i",
		underlay,
		...def.lanes.flatMap((_, i) => ["-i", join(work, `lane-${i}`, "take.mp4")]),
		...laneGifs.flatMap((g) => ["-i", g]),
		"-i",
		shellGif,
		...loop,
		"-i",
		mask,
	];
	await run(
		[
			"ffmpeg",
			...quiet,
			"-stats",
			...inputs,
			"-/filter_complex",
			join(work, "graph.txt"),
			"-map",
			"[out]",
			"-t",
			`${total}`,
			"-an",
			"-r",
			`${FPS}`,
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
	await mkdir(outDir, { recursive: true });
	const mp4 = join(outDir, `${outName}.mp4`);
	const webm = join(outDir, `${outName}.webm`);
	const jpg = join(outDir, `${outName}.jpg`);
	let crf = 24;
	for (;;) {
		await run(["ffmpeg", ...mp4Args(inter, mp4, crf)], "ffmpeg mp4");
		const bytes = (await stat(mp4)).size;
		console.error(`mp4 crf ${crf}: ${(bytes / 1e6).toFixed(2)} MB`);
		if (bytes <= 6_000_000 || crf >= 40) break;
		crf += 3;
	}
	await run(["ffmpeg", ...webmArgs(inter, webm)], "ffmpeg webm");
	const posterAt = Math.min(total - 0.5, aligned.shellOffS + def.posterAfterShellS);
	await run(
		["ffmpeg", ...quiet, "-ss", `${posterAt}`, "-i", mp4, "-frames:v", "1", "-q:v", "2", "-update", "1", jpg],
		"ffmpeg poster"
	);
	if (sheet) {
		await run(
			[
				"ffmpeg",
				...quiet,
				"-i",
				mp4,
				"-vf",
				`fps=1/3,scale=480:-1,drawtext=fontfile=/System/Library/Fonts/Menlo.ttc:text='%{pts\\:hms}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x${Math.ceil(total / 3 / 4)}`,
				"-frames:v",
				"1",
				join(work, "sheet.jpg"),
			],
			"ffmpeg sheet"
		);
	}
	return { mp4, jpg, totalS: total };
}

async function loadDefinition(file: string, name: string): Promise<LanesDemoDefinition> {
	if (!existsSync(file)) throw new Error(`no definition at ${file}`);
	const mod = (await import(file)) as { demo?: LanesDemoDefinition };
	if (!mod.demo) throw new Error(`${file} must export \`demo\``);
	if (mod.demo.name !== name) throw new Error(`${file} names itself "${mod.demo.name}", expected "${name}"`);
	return mod.demo;
}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			worktrees: { type: "string" },
			"record-only": { type: "boolean" },
			"render-only": { type: "boolean" },
			sheet: { type: "boolean" },
			out: { type: "string" },
		},
	});
	const name = positionals[0];
	if (!name || !values.worktrees || (values["record-only"] && values["render-only"])) {
		console.error(
			"usage: bun run demo:lanes <feature>/<clip> --worktrees <dir> [--record-only|--render-only] [--sheet] [--out dir]"
		);
		return 1;
	}
	const paths = demoPaths(REPO, name, tmpdir());
	const def = await loadDefinition(paths.definition, name);
	const work = resolve(values.out ?? paths.work);
	await mkdir(work, { recursive: true });
	process.env.WARDEN_SIMD ??= DEFAULT_SIMD;
	const recFile = join(work, "lanes.json");
	if (!values["render-only"]) {
		const rec = await recordLanes(def, resolve(values.worktrees), work);
		await writeFile(recFile, `${JSON.stringify(rec, null, "\t")}\n`);
	}
	if (values["record-only"]) {
		console.error(`recorded ${work}`);
		return 0;
	}
	const rec = JSON.parse(await readFile(recFile, "utf8")) as Recorded;
	const res = await render(def, rec, work, paths.publicDir, name.split("/")[1] ?? "reel", values.sheet === true);
	const size = (await stat(res.mp4)).size;
	console.error(`${res.mp4} ${(size / 1e6).toFixed(2)} MB, ${res.totalS.toFixed(1)} s\n${res.jpg}`);
	if (values.sheet) console.error(join(work, "sheet.jpg"));
	return 0;
}

const code = await main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	return 1;
});
process.exit(code);
