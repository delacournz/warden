#!/usr/bin/env bun
/**
 * Regenerates the app icon (`src-tauri/icons/`) from warden-monorepo's brand master:
 *   packages/brand/assets/warden/icon-1024.png
 *
 *   bun scripts/icons.ts                      # fetch from GitHub (delacournz/warden-monorepo@develop) via `gh`
 *   bun scripts/icons.ts --ref <ref>          # another branch / tag / sha
 *   bun scripts/icons.ts <brand-dir|png>      # a local checkout's packages/brand, or any 1024 png
 *   WARDEN_BRAND_DIR=<brand-dir> bun scripts/icons.ts
 *
 * `tauri icon` renders into a temp dir; only the files `bundle.icon` in tauri.conf.json lists (plus icon.png,
 * the runtime window icon) are copied back, so the Android/iOS/Store extras it also writes never land here.
 *
 * `icon.icns` is not byte-reproducible, so `src-tauri/icons/source.sha256` records the master it came from and an
 * unchanged master is a no-op (`--force` regenerates anyway).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const BRAND_REPO = "delacournz/warden-monorepo";
export const BRAND_ICON_PATH = "assets/warden/icon-1024.png";
const BRAND_PACKAGE = "packages/brand";
const SOURCE_LOCK = "source.sha256";

type TauriConf = { bundle?: { icon?: string[] } };
export type Args = { source: string | undefined; ref: string; force: boolean };
export type Source = { kind: "file"; path: string } | { kind: "github"; ref: string };

/** Basenames to copy back: every `bundle.icon` entry, plus `icon.png`. */
export function iconFiles(conf: TauriConf): string[] {
	const listed = conf.bundle?.icon;
	if (!listed?.length) throw new Error("tauri.conf.json has no bundle.icon");
	return [...new Set([...listed.map((path) => basename(path)), "icon.png"])];
}

export function parseArgs(argv: string[]): Args {
	let source: string | undefined;
	let ref = "develop";
	let force = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--force") {
			force = true;
		} else if (arg === "--ref") {
			const value = argv[++i];
			if (!value) throw new Error("--ref needs a value");
			ref = value;
		} else if (arg !== undefined) {
			source = arg;
		}
	}
	return { source, ref, force };
}

/** sha256 hex of the master png, stored in `src-tauri/icons/source.sha256`. */
export function sourceHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** A `.png` is used as is; anything else is a brand package dir. No source and no env → GitHub. */
export function resolveSource(args: Args, env: Record<string, string | undefined>): Source {
	const local = args.source ?? env.WARDEN_BRAND_DIR;
	if (!local) return { kind: "github", ref: args.ref };
	return { kind: "file", path: local.endsWith(".png") ? local : join(local, BRAND_ICON_PATH) };
}

function run(cmd: string[], cwd: string): Uint8Array {
	const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${proc.stderr.toString()}`);
	return proc.stdout;
}

function fetchFromGitHub(ref: string, dir: string, cwd: string): string {
	const out = join(dir, "icon-1024.png");
	const url = `repos/${BRAND_REPO}/contents/${BRAND_PACKAGE}/${BRAND_ICON_PATH}?ref=${encodeURIComponent(ref)}`;
	writeFileSync(out, run(["gh", "api", "-H", "Accept: application/vnd.github.raw", url], cwd));
	return out;
}

function main(): void {
	const root = resolve(import.meta.dir, "..");
	const iconsDir = join(root, "src-tauri/icons");
	const conf: TauriConf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
	const files = iconFiles(conf);
	const args = parseArgs(Bun.argv.slice(2));
	const source = resolveSource(args, process.env);
	const lock = join(iconsDir, SOURCE_LOCK);
	const tmp = mkdtempSync(join(tmpdir(), "warden-viewer-icons-"));
	try {
		const png = source.kind === "file" ? source.path : fetchFromGitHub(source.ref, tmp, root);
		const from = source.kind === "file" ? source.path : `${BRAND_REPO}@${source.ref}`;
		const hash = sourceHash(readFileSync(png));
		const current = existsSync(lock) ? readFileSync(lock, "utf8").trim() : undefined;
		if (!args.force && current === hash) {
			console.log(`icons up to date with ${from} (${hash.slice(0, 12)}); --force to regenerate`);
			return;
		}
		const out = join(tmp, "out");
		run(["bun", "run", "tauri", "icon", png, "-o", out], root);
		for (const file of files) copyFileSync(join(out, file), join(iconsDir, file));
		writeFileSync(lock, `${hash}\n`);
		console.log(`icons from ${from} (${hash.slice(0, 12)}) → src-tauri/icons: ${files.join(", ")}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (import.meta.main) main();
