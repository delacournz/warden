import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AsyncResult, err, ok } from "@warden/types/result";
import { type Exec, execError } from "../exec";
import type { Platform } from "../types";
import { LOCAL_BUILD_TIMEOUT_MS } from "./builds.defaults";
import type { Project } from "./config";
import { computeFingerprint } from "./fingerprint";

const SIM_PRODUCTS = join("Build", "Products", "Debug-iphonesimulator");

function children(dir: string): string[] {
	try {
		return readdirSync(dir).map((n) => join(dir, n));
	} catch {
		return [];
	}
}

function mtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Recursively collect files ending in `ext` under `dir` (bounded depth). */
function findFiles(dir: string, ext: string, depth = 6): string[] {
	if (depth < 0) return [];
	return children(dir).flatMap((p) => {
		if (p.endsWith(ext)) return [p];
		try {
			return statSync(p).isDirectory() ? findFiles(p, ext, depth - 1) : [];
		} catch {
			return [];
		}
	});
}

/**
 * Candidate build outputs: iOS `.app`s in `<root>/ios/build/…/Debug-iphonesimulator` and every
 * DerivedData project's `…/Debug-iphonesimulator`; Android `.apk`s under
 * `<root>/android/app/build/outputs/apk`.
 */
export function artifactCandidates(root: string, platform: Platform, derivedData: string): string[] {
	if (platform === "android") return findFiles(join(root, "android", "app", "build", "outputs", "apk"), ".apk");
	const productDirs = [
		join(root, "ios", "build", SIM_PRODUCTS),
		...children(derivedData).map((d) => join(d, SIM_PRODUCTS)),
	];
	return productDirs.flatMap((d) => children(d).filter((p) => p.endsWith(".app")));
}

/** Newest candidate modified at/after `since` (the build start). */
export function locateArtifact(
	root: string,
	platform: Platform,
	derivedData: string,
	since: number
): string | undefined {
	return artifactCandidates(root, platform, derivedData)
		.map((path) => ({ path, at: mtime(path) }))
		.filter((c) => c.at >= since)
		.sort((a, b) => b.at - a.at)[0]?.path;
}

export function derivedDataDir(env: Record<string, string | undefined>): string {
	return join(env.HOME ?? "~", "Library", "Developer", "Xcode", "DerivedData");
}

export type LocalBuildDeps = {
	exec: Exec;
	project: Project;
	platform: Platform;
	hash: string;
	env: Record<string, string | undefined>;
	/** wall clock (ms) — artifacts older than the build start are ignored */
	now: () => number;
	log: (line: string) => void;
	timeoutMs?: number;
};

/**
 * Run `build.<platform>` in the project root, locate the produced `.app`/`.apk`, and verify the
 * project's fingerprint still equals `hash` (a build that changed native inputs — or a source tree
 * edited mid-build — must not be cached under the old hash).
 */
export async function runLocalBuild(deps: LocalBuildDeps): AsyncResult<string> {
	const { project, platform } = deps;
	const command = project.build[platform];
	const since = deps.now() - 1_000;
	deps.log(`building ${platform} locally: ${command} (in ${project.root})`);
	const argv = ["sh", "-c", command];
	const res = await deps.exec(argv, {
		cwd: project.root,
		env: { EXPO_NO_TELEMETRY: "1" },
		timeoutMs: deps.timeoutMs ?? LOCAL_BUILD_TIMEOUT_MS,
	});
	if (res.exitCode !== 0) return err(`local build failed: ${execError(argv, res)}`);
	const artifact = locateArtifact(project.root, platform, derivedDataDir(deps.env), since);
	if (!artifact || !existsSync(artifact)) {
		return err(
			`local build succeeded but no ${platform === "ios" ? ".app" : ".apk"} was found (DerivedData / android/app/build/outputs)`
		);
	}
	const after = await computeFingerprint(deps.exec, project, platform);
	if (!after.success) return after;
	if (after.data !== deps.hash) {
		return err(`fingerprint changed during the build (${deps.hash} → ${after.data}); not caching ${artifact}`);
	}
	return ok(artifact);
}
