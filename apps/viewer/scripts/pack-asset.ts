#!/usr/bin/env bun
/**
 * Packs a built viewer into the release asset `warden fetchViewer` downloads (see apps/cli/src/npm/viewer.ts):
 *   dist-assets/warden-viewer-<target>.tgz
 * with `warden viewer.app/` (macOS) or `warden-viewer.exe` (Windows) at the archive root. Prints the sha256.
 *
 *   bun scripts/pack-asset.ts <darwin-arm64|darwin-x64|win32-x64> [--profile release|debug]
 *
 * tar does the packing: it keeps the exec bit and the .app's symlinks, which a JS tar would not.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const VIEWER_TARGETS = ["darwin-arm64", "darwin-x64", "win32-x64"] as const;
export type ViewerTarget = (typeof VIEWER_TARGETS)[number];

const TRIPLES: Record<ViewerTarget, string> = {
	"darwin-arm64": "aarch64-apple-darwin",
	"darwin-x64": "x86_64-apple-darwin",
	"win32-x64": "x86_64-pc-windows-msvc",
};

const MAC_APP = "warden viewer.app";
const WIN_EXE = "warden-viewer.exe";

export function isViewerTarget(value: string): value is ViewerTarget {
	return VIEWER_TARGETS.some((target) => target === value);
}

export function rustTriple(target: ViewerTarget): string {
	return TRIPLES[target];
}

export function assetName(target: ViewerTarget): string {
	return `warden-viewer-${target}.tgz`;
}

/** The single entry at the archive root. */
export function stagedEntry(target: ViewerTarget): string {
	return target.startsWith("darwin-") ? MAC_APP : WIN_EXE;
}

/** Built output paths relative to `apps/viewer`, best first: a `--target` build nests under the triple. */
export function bundleCandidates(target: ViewerTarget, profile: string): string[] {
	const tail = target.startsWith("darwin-") ? `bundle/macos/${MAC_APP}` : WIN_EXE;
	return [`src-tauri/target/${rustTriple(target)}/${profile}/${tail}`, `src-tauri/target/${profile}/${tail}`];
}

type Packed = { tgz: string; sha256: string };

async function pack(target: ViewerTarget, profile: string): Promise<Packed> {
	const root = resolve(import.meta.dir, "..");
	const source = bundleCandidates(target, profile)
		.map((path) => join(root, path))
		.find((path) => existsSync(path));
	if (!source) {
		throw new Error(`no built viewer for ${target}; looked in ${bundleCandidates(target, profile).join(", ")}`);
	}

	const outDir = join(root, "dist-assets");
	const stage = join(outDir, `stage-${target}`);
	rmSync(stage, { recursive: true, force: true });
	mkdirSync(stage, { recursive: true });
	// verbatimSymlinks: keep the .app's symlinks as links, not as copies of their targets.
	cpSync(source, join(stage, stagedEntry(target)), { recursive: true, verbatimSymlinks: true });

	const asset = assetName(target);
	// Relative paths and a cwd: GNU tar on Windows reads `C:\…` as a remote host.
	const proc = Bun.spawn(["tar", "-czf", `../${asset}`, stagedEntry(target)], {
		cwd: stage,
		env: { ...process.env, COPYFILE_DISABLE: "1" },
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await proc.exited) !== 0) throw new Error(`tar failed for ${asset}`);
	rmSync(stage, { recursive: true, force: true });

	const tgz = join(outDir, asset);
	return { tgz, sha256: createHash("sha256").update(readFileSync(tgz)).digest("hex") };
}

if (import.meta.main) {
	const [target, ...flags] = process.argv.slice(2);
	if (!target || !isViewerTarget(target)) {
		console.error(`usage: pack-asset <${VIEWER_TARGETS.join("|")}> [--profile release|debug]`);
		process.exit(2);
	}
	const profileAt = flags.indexOf("--profile");
	const profile = profileAt >= 0 ? (flags[profileAt + 1] ?? "release") : "release";
	const packed = await pack(target, profile);
	console.log(`packed ${packed.tgz}`);
	console.log(`${packed.sha256}  ${assetName(target)}`);
}
