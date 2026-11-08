#!/usr/bin/env bun
/**
 * Demo-video kit: `bun run demo <feature>/<clip> [--record-only|--render-only] [--out dir] [--sheet]`.
 *
 * Definition: apps/example/demos/<feature>/<clip>.demo.ts. Record writes take.mp4 + steps.json
 * into the work dir (default $TMPDIR/warden-demo/<feature>/<clip>); render builds the 1920x1080
 * mp4 + jpg poster into apps/docs/public/demos/<feature>/. Needs ffmpeg, ffprobe and uv.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DemoDefinition, RecordedTake } from "./demo.types";
import { type DemoPaths, demoPaths } from "./paths";
import { record } from "./record";
import { buildPlan, PHONE } from "./timeline";

const REPO = resolve(import.meta.dir, "../..");
const MAX_BYTES = 2_000_000;
const CRF_LADDER = [24, 27, 30, 33, 36] as const;
const DEFAULT_SIMD = "/Users/chris/.warden/simd/0.6.0/warden-simd";

async function sh(cmd: string, env: Record<string, string> = {}): Promise<string> {
	const proc = Bun.spawn(["bash", "-o", "pipefail", "-c", cmd], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "inherit",
	});
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) throw new Error(`command failed (${code}): ${cmd.slice(0, 160)}`);
	return out;
}

async function loadDefinition(paths: DemoPaths, name: string): Promise<DemoDefinition> {
	const file = paths.definition;
	if (!existsSync(file)) throw new Error(`no definition at ${file}`);
	const mod = (await import(file)) as { demo?: DemoDefinition };
	if (!mod.demo) throw new Error(`${file} must export \`demo\``);
	if (mod.demo.name !== name) throw new Error(`${file} names itself "${mod.demo.name}", expected "${name}"`);
	return mod.demo;
}

async function render(
	def: DemoDefinition,
	paths: DemoPaths,
	work: string
): Promise<{ mp4: string; jpg: string; durationS: number }> {
	const takePath = join(work, "take.mp4");
	const take = JSON.parse(await readFile(join(work, "steps.json"), "utf8")) as RecordedTake;
	const videoS = Number.parseFloat(
		(await sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${takePath}"`)).trim()
	);
	const fontsDir = join(REPO, "node_modules/@expo-google-fonts");
	const plan = buildPlan(def, take, videoS, fontsDir);
	await writeFile(join(work, "plan.json"), `${JSON.stringify(plan, null, "\t")}\n`);

	const py = join(import.meta.dir, "render.py");
	const plate = join(work, "plan.json");
	const mask = join(work, "mask.png");
	await sh(`uv run --script "${py}" "${plate}" "${mask}" --mask-only`);

	const dur = plan.durationS.toFixed(3);
	const filter = [
		`[1:v]fps=${plan.fps},scale=${PHONE.width}:${PHONE.height}:flags=lanczos,format=rgba,tpad=stop_mode=clone:stop_duration=${dur}[p]`,
		"[2:v]format=gray[m]",
		"[p][m]alphamerge[pm]",
		`[0:v][pm]overlay=${PHONE.x}:${PHONE.y}:eof_action=pass,format=yuv420p[v]`,
	].join(";");

	await mkdir(paths.publicDir, { recursive: true });
	const { mp4, jpg } = paths;
	for (const crf of CRF_LADDER) {
		await sh(
			`uv run --script "${py}" "${plate}" "${mask}" | ffmpeg -y -v error -f rawvideo -pix_fmt rgb24 -s 1920x1080 -framerate ${plan.fps} -i - -i "${takePath}" -t ${dur} -loop 1 -framerate ${plan.fps} -i "${mask}" -filter_complex "${filter}" -map "[v]" -t ${dur} -r ${plan.fps} -c:v libx264 -profile:v high -preset slow -crf ${crf} -an -movflags +faststart "${mp4}"`
		);
		const size = (await stat(mp4)).size;
		console.error(`crf ${crf}: ${(size / 1e6).toFixed(2)} MB`);
		if (size <= MAX_BYTES) break;
	}
	await sh(`ffmpeg -y -v error -sseof -0.2 -i "${mp4}" -frames:v 1 -q:v 3 -update 1 "${jpg}"`);
	await copyFile(mp4, join(work, "out.mp4"));
	return { mp4, jpg, durationS: plan.durationS };
}

/** Contact sheet of the finished mp4 with pts burned in: the inspection step of the loop. */
async function sheet(file: string, out: string): Promise<void> {
	const font = "/System/Library/Fonts/Menlo.ttc";
	await sh(
		`ffmpeg -y -v error -i "${file}" -vf "fps=1,scale=480:-1,drawtext=fontfile=${font}:text='%{pts\\:hms}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x4" -frames:v 1 "${out}"`
	);
}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			"record-only": { type: "boolean" },
			"render-only": { type: "boolean" },
			sheet: { type: "boolean" },
			out: { type: "string" },
		},
	});
	const name = positionals[0];
	if (!name || (values["record-only"] && values["render-only"])) {
		console.error("usage: bun run demo <feature>/<clip> [--record-only|--render-only] [--sheet] [--out dir]");
		return 1;
	}
	const paths = demoPaths(REPO, name, tmpdir());
	const def = await loadDefinition(paths, name);
	const work = resolve(values.out ?? paths.work);
	await mkdir(work, { recursive: true });
	process.env.WARDEN_SIMD ??= DEFAULT_SIMD;
	if (!values["render-only"]) await record(def, REPO, work, paths.label);
	if (values["record-only"]) {
		console.error(`recorded ${work}/take.mp4`);
		return 0;
	}
	const res = await render(def, paths, work);
	const size = (await stat(res.mp4)).size;
	console.error(`${res.mp4} ${(size / 1e6).toFixed(2)} MB, ${res.durationS.toFixed(1)} s\n${res.jpg}`);
	if (values.sheet) {
		await sheet(res.mp4, join(work, "sheet.jpg"));
		console.error(`${join(work, "sheet.jpg")}`);
	}
	return 0;
}

const code = await main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	return 1;
});
process.exit(code);
