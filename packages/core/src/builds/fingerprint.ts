import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { findNodeBin } from "../node-bin";
import type { Store } from "../store";
import type { Platform } from "../types";
import { FINGERPRINT_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "./builds.defaults";
import type { Project } from "./config";
import { combineKey, jsInputsHash, type ReadFile } from "./js-inputs";

const BARE_HASH = /^[0-9a-f]{8,}$/i;

/** `{ hash }` with a non-empty string hash; a hand-written check, so zod stays off the `run` / `app` start path (15-2). */
function jsonHash(text: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("hash" in parsed)) return undefined;
		return typeof parsed.hash === "string" && parsed.hash.length > 0 ? parsed.hash : undefined;
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
	return findNodeBin(root, "fingerprint", exists);
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

/** Where `computeCacheKey` keeps the native hash between runs (17-5); absent = always run the fingerprint. */
export type FingerprintMemo = { store: Store; now: number };

export type FingerprintMemoRow = { signature: string; native: string; computedAt: number };

/** The memo row's key: a variant or another fingerprint command (local bin vs bunx) is its own row. */
function memoKey(project: Project, platform: Platform): [string, string, string, string] {
	return [project.root, platform, project.variant ?? "", JSON.stringify(fingerprintArgv(project, platform))];
}

export function getFingerprintMemo(store: Store, project: Project, platform: Platform): FingerprintMemoRow | undefined {
	const row = store.db
		.query<{ signature: string; native: string; computed_at: number }, [string, string, string, string]>(
			"SELECT signature, native, computed_at FROM fingerprints WHERE root = ? AND platform = ? AND variant = ? AND command = ?"
		)
		.get(...memoKey(project, platform));
	return row ? { signature: row.signature, native: row.native, computedAt: row.computed_at } : undefined;
}

function putFingerprintMemo(
	memo: FingerprintMemo,
	project: Project,
	platform: Platform,
	signature: string,
	native: string
) {
	memo.store.db
		.query(
			`INSERT INTO fingerprints (root, platform, variant, command, signature, native, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (root, platform, variant, command) DO UPDATE SET signature = excluded.signature, native = excluded.native,
			   computed_at = excluded.computed_at`
		)
		.run(...memoKey(project, platform), signature, native, memo.now);
}

const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];
/** what an install rewrites even when the lockfile is unchanged */
const INSTALL_MARKERS = [
	"node_modules",
	"node_modules/.bun-tag",
	"node_modules/.package-lock.json",
	"node_modules/.modules.yaml",
	"node_modules/.yarn-state.yml",
];
const APP_CONFIG =
	/^(app\.json|app\.config\.[cm]?[jt]s|app\.config\.json|fingerprint\.config\.[cm]?[jt]s|\.fingerprintignore)$/;
/** a config that reads the environment can fingerprint differently with nothing on disk changed */
const READS_ENV = /\bprocess\.env\b|\bimport\.meta\.env\b|\bBun\.env\b/;
/** build output / per-machine state inside `ios/` and `android/` that `@expo/fingerprint` ignores by default */
const NATIVE_SKIP = new Set([
	"Pods",
	"build",
	".cxx",
	".gradle",
	"xcuserdata",
	".swiftpm",
	".DS_Store",
	".xcode.env.local",
]);

/** `size:mtime` of `path`, `-` when absent. */
function statSig(path: string): string {
	const st = lstatSync(path, { throwIfNoEntry: false });
	return st ? `${st.size}:${st.mtimeMs}` : "-";
}

/**
 * `ios/` / `android/` (git-ignored under CNG, so `git status` cannot see them): existence, then every
 * entry's path, size and mtime (any edit, add, delete or older-mtime restore changes it), hashed.
 */
function nativeDirSig(dir: string): string {
	const top = lstatSync(dir, { throwIfNoEntry: false });
	if (!top?.isDirectory()) return "-";
	const hash = createHash("sha256").update(`${top.ino}:${top.mtimeMs}`);
	const walk = (at: string) => {
		for (const name of readdirSync(at).sort()) {
			if (NATIVE_SKIP.has(name)) continue;
			const path = join(at, name);
			const st = lstatSync(path, { throwIfNoEntry: false });
			if (!st) continue;
			hash.update(`\n${relative(dir, path)} ${st.size}:${st.mtimeMs}`);
			if (st.isDirectory()) walk(path);
		}
	};
	walk(dir);
	return hash.digest("hex");
}

/** Paths in `git status --porcelain=v1 -z` output (both sides of a rename / copy). */
function statusPaths(raw: string): string[] {
	const tokens = raw.split("\0").filter((t) => t !== "");
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i] ?? "";
		paths.push(entry.slice(3));
		if (/[RC]/.test(entry.slice(0, 2)) && tokens[i + 1] !== undefined) paths.push(tokens[++i] ?? "");
	}
	return paths;
}

/**
 * A cheap signature of everything `@expo/fingerprint` reads (17-5): HEAD, the dirty set with each dirty
 * path's size+mtime (editing an already-modified file keeps its status line), lockfiles and install
 * markers from the project root up to the git toplevel, the app config files, and `ios/` / `android/`.
 * undefined = do not memoise (not a git checkout, or an app config that reads the environment).
 */
export async function treeSignature(exec: Exec, root: string): Promise<string | undefined> {
	const opts = { cwd: root, timeoutMs: PROBE_TIMEOUT_MS };
	const [rev, status] = await Promise.all([
		exec(["git", "rev-parse", "--show-toplevel", "HEAD"], opts),
		exec(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], opts),
	]);
	if (rev.exitCode !== 0 || status.exitCode !== 0) return undefined;
	const [toplevel, head] = rev.stdout.trim().split("\n");
	if (!toplevel || !head) return undefined;
	const configs = appConfigs(root);
	if (configs === undefined) return undefined;
	const parts: string[] = [`head ${head}`, `status ${createHash("sha256").update(status.stdout).digest("hex")}`];
	for (const path of statusPaths(status.stdout)) parts.push(`dirty ${path} ${statSig(join(toplevel, path))}`);
	parts.push(...installSigs(root, toplevel));
	for (const name of configs) parts.push(`config ${name} ${statSig(join(root, name))}`);
	for (const name of ["ios", "android"]) parts.push(`native ${name} ${nativeDirSig(join(root, name))}`);
	return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** The app config files in `root`, sorted; undefined when a script one reads the environment. */
function appConfigs(root: string): string[] | undefined {
	const configs = readdirSync(root)
		.filter((n) => APP_CONFIG.test(n))
		.sort();
	const scripts = configs.filter((n) => !n.endsWith(".json") && n !== ".fingerprintignore");
	return scripts.some((n) => READS_ENV.test(readFileSync(join(root, n), "utf8"))) ? undefined : configs;
}

/** Lockfiles and install markers in `root` and each parent up to the git `toplevel` (hoisted monorepos). */
function installSigs(root: string, toplevel: string): string[] {
	const sigs: string[] = [];
	// git prints the toplevel resolved; walk the resolved root so a symlinked path still reaches it
	const start = realpathSync(root);
	for (let dir = start; ; dir = dirname(dir)) {
		for (const name of [...LOCKFILES, ...INSTALL_MARKERS]) {
			sigs.push(`${relative(start, dir) || "."}/${name} ${statSig(join(dir, name))}`);
		}
		if (dir === toplevel || relative(toplevel, dir).startsWith("..") || dirname(dir) === dir) return sigs;
	}
}

/** `treeSignature`, with an unreadable tree (permissions, a racing delete) meaning "do not memoise". */
async function signatureOrUndefined(exec: Exec, root: string): Promise<string | undefined> {
	try {
		return await treeSignature(exec, root);
	} catch {
		return undefined;
	}
}

/**
 * The native fingerprint, from the memo when the tree's signature is the one it was computed at. A
 * project `fingerprint.command` is opaque (it may read anything), so it always runs. The signature is
 * taken again after a run and the result kept only when nothing moved meanwhile.
 */
async function memoisedFingerprint(
	exec: Exec,
	project: Project,
	platform: Platform,
	memo: FingerprintMemo
): AsyncResult<string> {
	if (project.fingerprintCommand) return computeFingerprint(exec, project, platform);
	const before = await signatureOrUndefined(exec, project.root);
	if (before === undefined) return computeFingerprint(exec, project, platform);
	const row = getFingerprintMemo(memo.store, project, platform);
	if (row?.signature === before) return ok(row.native);
	const fresh = await computeFingerprint(exec, project, platform);
	if (!fresh.success) return fresh;
	if ((await signatureOrUndefined(exec, project.root)) === before)
		putFingerprintMemo(memo, project, platform, before, fresh.data);
	return fresh;
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
 * `jsInputs` files, so a JS-only change is a new build (a Release binary embeds its bundle). The two
 * halves are independent, so they are computed side by side: the JS hash (a couple of `git ls-files`)
 * hides inside the native fingerprint's runtime. With `memo` the native hash is reused while the tree's
 * signature is unchanged (`treeSignature`); without it (the post-build recompute) it always runs.
 */
export async function computeCacheKey(
	exec: Exec,
	project: Project,
	platform: Platform,
	readFile?: ReadFile,
	memo?: FingerprintMemo
): AsyncResult<CacheKey> {
	const [native, js] = await Promise.all([
		memo ? memoisedFingerprint(exec, project, platform, memo) : computeFingerprint(exec, project, platform),
		project.jsInputs === undefined
			? undefined
			: jsInputsHash({
					exec,
					root: project.root,
					jsInputs: project.jsInputs,
					...(readFile ? { readFile } : {}),
				}),
	]);
	if (!native.success) return native;
	if (js === undefined) {
		const key = project.buildConfiguration === "Release" ? releaseKey(native.data) : native.data;
		return ok({ key, native: native.data });
	}
	if (!js.success) return js;
	return ok({ key: combineKey(native.data, js.data), native: native.data, js: js.data });
}
