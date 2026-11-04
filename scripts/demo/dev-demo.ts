#!/usr/bin/env bun
/**
 * `bun run demo:dev <feature>/<clip> [--record-only|--render-only] [--sheet] [--out dir]`
 *
 * The `warden dev` reel: definition `apps/example/demos/<feature>/<clip>.demo.ts` exporting `demo: DevDemoDefinition`;
 * `dev-take.ts` records (real TUI in a PTY + simulator video), `dev-render.ts` composes
 * `apps/docs/public/demos/<feature>/<clip>.{mp4,webm,jpg}`. Needs ffmpeg, agg, uv.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DevDemoDefinition, DevTake } from "./demo.types";
import { renderDev } from "./dev-render";
import { recordDev } from "./dev-take";
import { demoPaths } from "./paths";

const REPO = resolve(import.meta.dir, "../..");
const DEFAULT_SIMD = "/Users/chris/.warden/simd/0.6.0/warden-simd";

async function loadDefinition(file: string, name: string): Promise<DevDemoDefinition> {
	if (!existsSync(file)) throw new Error(`no definition at ${file}`);
	const mod = (await import(file)) as { demo?: DevDemoDefinition };
	if (!mod.demo) throw new Error(`${file} must export \`demo\``);
	if (mod.demo.name !== name) throw new Error(`${file} names itself "${mod.demo.name}", expected "${name}"`);
	return mod.demo;
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
		console.error("usage: bun run demo:dev <feature>/<clip> [--record-only|--render-only] [--sheet] [--out dir]");
		return 1;
	}
	const paths = demoPaths(REPO, name, tmpdir());
	const def = await loadDefinition(paths.definition, name);
	const work = resolve(values.out ?? paths.work);
	await mkdir(work, { recursive: true });
	process.env.WARDEN_SIMD ??= DEFAULT_SIMD;
	if (!values["render-only"]) await recordDev(def, REPO, work, paths.label);
	if (values["record-only"]) {
		console.error(`recorded ${work}/take.mp4 + tui.cast + dev.json`);
		return 0;
	}
	const take = JSON.parse(await readFile(join(work, "dev.json"), "utf8")) as DevTake;
	const outName = name.split("/")[1] ?? "reel";
	const res = await renderDev(def, take, {
		work,
		outDir: paths.publicDir,
		outName,
		repoRoot: REPO,
		sheet: values.sheet === true,
		maxBytes: 6_000_000,
	});
	const size = (await stat(res.mp4)).size;
	console.error(
		`${res.mp4} ${(size / 1e6).toFixed(2)} MB, ${res.durationS.toFixed(1)} s, ${res.ramps} ramp(s)\n${res.jpg}`
	);
	if (values.sheet) console.error(join(work, "sheet.jpg"));
	return 0;
}

const code = await main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	return 1;
});
process.exit(code);
