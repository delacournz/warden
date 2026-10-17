import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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
const APP_CONFIG = /^(app\.json|app\.config\.[cm]?[jt]s|app\.config\.json|\.fingerprintignore)$/;
/** a `fingerprint.config.*` can add `extraSources` (any file or dir, inside the repo or not): never memoised */
const FINGERPRINT_CONFIG = /^fingerprint\.config\.[cm]?[jt]s$/;
/** `.env*` files `@expo/env` loads before the config is evaluated (often git-ignored) */
const ENV_FILE = /^\.env/;
/** a config that reads the environment can fingerprint differently with nothing on disk changed */
const READS_ENV = /\bprocess\.env\b|\bimport\.meta\.env\b|\bBun\.env\b/;
/** a script config that computes paths: what it reads cannot be listed from its text */
const COMPUTES_PATHS =
	/\$\{|\b__dirname\b|\b__filename\b|\bimport\.meta\.(dirname|url|filename)\b|\bresolve\(|\bjoin\(/;
/** the string literals of a script config */
const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g;

/**
 * `@expo/fingerprint`'s default ignores under `ios/` and `android/` (its `DEFAULT_IGNORE_PATHS`), as
 * paths relative to that dir. Anchored: `android/app/src/.../build/` is hashed by the fingerprint, so it
 * is part of the signature too. Only the patterns that skip a whole dir (`…/**\/*`) or one file are here;
 * `project.xcworkspace` is not, since its contents are still hashed.
 */
function nativeIgnored(native: string, rel: string, name: string): boolean {
	if (name === ".DS_Store" || name === ".swiftpm") return true;
	if (native === "ios")
		return (
			rel === "Pods" || rel === "build" || rel === ".xcode.env.local" || /^[^/]+\.xcworkspace\/xcuserdata$/.test(rel)
		);
	return ["build", ".cxx", ".gradle", "app/build", "app/.cxx", "app/.gradle", "gradlew.bat"].includes(rel);
}

/** `size:mtime:ctime` of `path`, `-` when absent (ctime moves on a restore that preserves size and mtime). */
function statSig(path: string): string {
	const st = lstatSync(path, { throwIfNoEntry: false });
	return st ? `${st.size}:${st.mtimeMs}:${st.ctimeMs}` : "-";
}

/**
 * `ios/` / `android/` (git-ignored under CNG, so `git status` cannot see them): existence, then every
 * entry's path, size, mtime and ctime (any edit, add, delete or older-mtime restore changes it), hashed.
 */
function nativeDirSig(dir: string): string {
	const top = lstatSync(dir, { throwIfNoEntry: false });
	if (!top?.isDirectory()) return "-";
	const native = basename(dir);
	const hash = createHash("sha256").update(`${top.ino}:${top.mtimeMs}:${top.ctimeMs}`);
	const walk = (at: string) => {
		for (const name of readdirSync(at).sort()) {
			const path = join(at, name);
			const rel = relative(dir, path);
			if (nativeIgnored(native, rel, name)) continue;
			const st = lstatSync(path, { throwIfNoEntry: false });
			if (!st) continue;
			hash.update(`\n${rel} ${st.size}:${st.mtimeMs}:${st.ctimeMs}`);
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
 * The `git status` argv of the signature. `--no-optional-locks`: a status refresh must never take
 * `.git/index.lock` from under a concurrent `git add` / `commit` (the signature is read-only).
 * `--ignore-submodules=none`: a dirty submodule shows even when `.gitmodules` says `ignore = dirty`.
 */
export const SIGNATURE_STATUS_ARGV = [
	"git",
	"--no-optional-locks",
	"status",
	"--porcelain=v1",
	"-z",
	"--untracked-files=all",
	"--ignore-submodules=none",
] as const;

/**
 * A cheap signature of everything `@expo/fingerprint` reads (17-5): HEAD, the dirty set with each dirty
 * path's size+mtime (editing an already-modified file keeps its status line), the submodules' commits,
 * lockfiles and install markers from the project root up to the git toplevel, the app config files, the
 * `.env*` files, the files the config names (icons, splash, fonts, `googleServicesFile`), and `ios/` /
 * `android/`. undefined = do not memoise: not a git checkout, a dirty submodule or nested repo (its
 * contents are invisible to the parent's status), a `fingerprint.config.*`, or an app config whose
 * inputs cannot be listed (reads the environment, a local plugin or import, a computed path).
 */
export async function treeSignature(exec: Exec, root: string): Promise<string | undefined> {
	const opts = { cwd: root, timeoutMs: PROBE_TIMEOUT_MS };
	const [rev, status] = await Promise.all([
		exec(["git", "rev-parse", "--show-toplevel", "HEAD"], opts),
		exec(SIGNATURE_STATUS_ARGV, opts),
	]);
	if (rev.exitCode !== 0 || status.exitCode !== 0) return undefined;
	const [toplevel, head] = rev.stdout.trim().split("\n");
	if (!toplevel || !head) return undefined;
	const configs = appConfigs(root);
	if (configs === undefined) return undefined;
	const parts: string[] = [`head ${head}`, `status ${createHash("sha256").update(status.stdout).digest("hex")}`];
	for (const path of statusPaths(status.stdout)) {
		// a submodule (or nested repo) with changes: edits inside it keep its status line and its dir's stat
		if (lstatSync(join(toplevel, path), { throwIfNoEntry: false })?.isDirectory()) return undefined;
		parts.push(`dirty ${path} ${statSig(join(toplevel, path))}`);
	}
	if (existsSync(join(toplevel, ".gitmodules"))) {
		const subs = await exec(["git", "--no-optional-locks", "submodule", "status", "--recursive"], {
			...opts,
			cwd: toplevel,
		});
		if (subs.exitCode !== 0) return undefined;
		parts.push(`submodules ${createHash("sha256").update(subs.stdout).digest("hex")}`);
	}
	parts.push(...installSigs(root, toplevel));
	for (const name of configs.files) parts.push(`config ${name} ${statSig(join(root, name))}`);
	for (const path of configs.external) parts.push(`external ${path} ${statSig(path)}`);
	for (const name of ["ios", "android"]) parts.push(`native ${name} ${nativeDirSig(join(root, name))}`);
	return createHash("sha256").update(parts.join("\n")).digest("hex");
}

type AppConfigs = {
	/** config and `.env*` files in the root, sorted */ files: string[] /** absolute paths the config names */;
	external: string[];
};

/** `obj.a.b…`, undefined when any step is not an object */
function at(value: unknown, ...keys: string[]): unknown {
	let cur = value;
	for (const k of keys) {
		if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
		cur = (cur as Record<string, unknown>)[k];
	}
	return cur;
}

const strings = (...values: unknown[]): string[] =>
	values.flatMap((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? strings(...v) : []));

const isLocalModule = (name: string) => name.startsWith("./") || name.startsWith("../") || name.startsWith("/");

/** Each config plugin's props by name; undefined when one is a local plugin (`./…`, which may read anything). */
function pluginProps(exp: unknown): Record<string, unknown> | undefined {
	const plugins = at(exp, "plugins");
	const props: Record<string, unknown> = {};
	for (const entry of Array.isArray(plugins) ? plugins : []) {
		const name: unknown = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : undefined;
		if (typeof name !== "string") continue;
		if (isLocalModule(name)) return undefined;
		if (Array.isArray(entry)) props[name] = entry[1];
	}
	return props;
}

/** `expo-font`'s `android.fonts` entries given as `{ fontDefinitions: [{ path }] }` */
function androidFontDefinitions(font: unknown): string[] {
	const fonts = at(font, "android", "fonts");
	if (!Array.isArray(fonts)) return [];
	return fonts.flatMap((f) => {
		const defs = at(f, "fontDefinitions");
		return Array.isArray(defs) ? strings(...defs.map((d) => at(d, "path"))) : [];
	});
}

/**
 * The files `@expo/fingerprint` hashes as `expoConfigExternalFile` for an `app.json` (icons, adaptive
 * icon, `expo-splash-screen` / `expo-font` plugin props, `googleServicesFile`; both platforms), resolved
 * against `root`. undefined = not memoisable: unparsable, or a local config plugin.
 */
function appJsonExternals(root: string, text: string): string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	const exp = at(parsed, "expo") ?? parsed;
	const props = pluginProps(exp);
	if (props === undefined) return undefined;
	const splash = props["expo-splash-screen"];
	const font = props["expo-font"];
	const densities = ["image", "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
	const files = strings(
		at(exp, "icon"),
		at(exp, "android", "icon"),
		at(exp, "ios", "icon"),
		at(exp, "ios", "icon", "light"),
		at(exp, "ios", "icon", "dark"),
		at(exp, "ios", "icon", "tinted"),
		at(exp, "android", "adaptiveIcon", "foregroundImage"),
		at(exp, "android", "adaptiveIcon", "backgroundImage"),
		at(exp, "android", "googleServicesFile"),
		at(exp, "ios", "googleServicesFile"),
		at(splash, "image"),
		at(splash, "dark", "image"),
		...densities.flatMap((d) => [at(splash, "android", d), at(splash, "android", "dark", d)]),
		...["image", "tabletImage"].flatMap((k) => [at(splash, "ios", k), at(splash, "ios", "dark", k)]),
		at(font, "fonts"),
		at(font, "ios", "fonts"),
		at(font, "android", "fonts"),
		androidFontDefinitions(font)
	);
	return files.map((f) => resolve(root, f));
}

/**
 * What a script config (`app.config.ts`…) reads, from its string literals: each one naming a file
 * (`./assets/icon.png`, `assets/icon.png`, an absolute path) is statted. undefined = not memoisable:
 * it reads the environment, computes a path, or names a `./…` module or dir (a local plugin, an import).
 */
function scriptExternals(root: string, text: string): string[] | undefined {
	if (READS_ENV.test(text) || COMPUTES_PATHS.test(text)) return undefined;
	const files: string[] = [];
	for (const m of text.matchAll(STRING_LITERAL)) {
		const lit = m[1] ?? m[2] ?? m[3] ?? "";
		if (lit === "") continue;
		const path = resolve(root, lit);
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (st?.isFile()) files.push(path);
		else if (isLocalModule(lit)) return undefined;
		else if (st?.isDirectory() && lit !== "ios" && lit !== "android") return undefined;
	}
	return files;
}

/** The app config and `.env*` files in `root` plus the files the config names; undefined = do not memoise. */
function appConfigs(root: string): AppConfigs | undefined {
	const names = readdirSync(root).sort();
	if (names.some((n) => FINGERPRINT_CONFIG.test(n))) return undefined;
	const files = names.filter((n) => APP_CONFIG.test(n) || ENV_FILE.test(n));
	const external: string[] = [];
	for (const name of names.filter((n) => APP_CONFIG.test(n) && n !== ".fingerprintignore")) {
		const text = readFileSync(join(root, name), "utf8");
		const found = name.endsWith(".json") ? appJsonExternals(root, text) : scriptExternals(root, text);
		if (found === undefined) return undefined;
		for (const path of found) {
			// a dir (a fonts folder): edits inside it do not move its stat
			if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return undefined;
			external.push(path);
		}
	}
	return { files, external: [...new Set(external)].sort() };
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
