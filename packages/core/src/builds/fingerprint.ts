import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { type Exec, execError } from "../exec";
import type { Platform } from "../types";
import { FINGERPRINT_TIMEOUT_MS } from "./builds.defaults";
import type { Project } from "./config";
import { combineKey, jsInputsHash, type ReadFile } from "./js-inputs";

const hashJson = z.object({ hash: z.string().min(1) });
const BARE_HASH = /^[0-9a-f]{8,}$/i;

function jsonHash(text: string): string | undefined {
	try {
		const parsed = hashJson.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data.hash : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Hash from fingerprint stdout: the whole output as JSON `{ hash }` (what `fingerprint:generate`
 * prints), else the last non-empty line as JSON `{ hash }` or a bare hex hash.
 */
export function parseFingerprintOutput(stdout: string): Result<string> {
	const whole = jsonHash(stdout);
	if (whole) return ok(whole);
	const last = stdout
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.at(-1);
	if (last) {
		const lineHash = jsonHash(last);
		if (lineHash) return ok(lineHash);
		if (BARE_HASH.test(last)) return ok(last);
	}
	return err(`could not read a fingerprint hash from output: ${stdout.trim().slice(0, 200) || "(empty)"}`);
}

/** `node_modules/.bin/fingerprint` nearest to `root` (hoisted monorepos put it at the repo root). */
export function findFingerprintBin(root: string, exists: (path: string) => boolean = existsSync): string | undefined {
	for (let dir = root; ; dir = dirname(dir)) {
		const bin = join(dir, "node_modules", ".bin", "fingerprint");
		if (exists(bin)) return bin;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * The fingerprint command for `platform`: the project's own `fingerprint.command` (`{platform}`
 * substituted, run by `sh -c`), else `@expo/fingerprint` from the project's node_modules (so its
 * `fingerprint.config.js` applies), else `bunx @expo/fingerprint`.
 */
export function fingerprintArgv(
	project: Project,
	platform: Platform,
	bin = findFingerprintBin(project.root)
): string[] {
	if (project.fingerprintCommand) {
		return ["sh", "-c", project.fingerprintCommand.replaceAll("{platform}", platform)];
	}
	const args = ["fingerprint:generate", "--platform", platform];
	return bin ? [bin, ...args] : ["bunx", "--bun", "@expo/fingerprint", ...args];
}

/** Compute the native fingerprint of `project` for `platform` (runs in the project root). */
export async function computeFingerprint(exec: Exec, project: Project, platform: Platform): AsyncResult<string> {
	const argv = fingerprintArgv(project, platform);
	const res = await exec(argv, {
		cwd: project.root,
		env: { EXPO_NO_TELEMETRY: "1" },
		timeoutMs: FINGERPRINT_TIMEOUT_MS,
	});
	if (res.exitCode !== 0) return err(`fingerprint failed: ${execError(argv, res)}`);
	return parseFingerprintOutput(res.stdout);
}

/** What identifies a build: `key` is the cache / install hash, `native` the `@expo/fingerprint` hash (EAS indexes by it). */
export type CacheKey = { key: string; native: string /** only for JS-aware projects */; js?: string };

/**
 * Key of a native-only Release build: the native fingerprint can't tell Debug from Release, but the
 * binaries differ (embedded bundle, no dev client), so they must not share a cache / install key.
 */
export function releaseKey(native: string): string {
	return combineKey(native, "configuration:Release");
}

/**
 * The cache / install key of `project`. Native projects: the native fingerprint (salted for Release). JS-aware projects
 * (`fingerprint.include: "native+js"`): sha256 of the native fingerprint + a content hash of the
 * `jsInputs` files, so a JS-only change is a new build (a Release binary embeds its bundle).
 */
export async function computeCacheKey(
	exec: Exec,
	project: Project,
	platform: Platform,
	readFile?: ReadFile
): AsyncResult<CacheKey> {
	const native = await computeFingerprint(exec, project, platform);
	if (!native.success) return native;
	if (project.jsInputs === undefined) {
		const key = project.buildConfiguration === "Release" ? releaseKey(native.data) : native.data;
		return ok({ key, native: native.data });
	}
	const js = await jsInputsHash({
		exec,
		root: project.root,
		jsInputs: project.jsInputs,
		...(readFile ? { readFile } : {}),
	});
	if (!js.success) return js;
	return ok({ key: combineKey(native.data, js.data), native: native.data, js: js.data });
}
