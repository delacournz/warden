import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import { nodeBin } from "@delacour/warden-runtime/node-bin";
import { BuildsTable, type FingerprintMemoKey, type FingerprintMemoRow } from "@delacour/warden-store/builds-table";
import type { Store } from "@delacour/warden-store/store";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { FINGERPRINT_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "./builds.defaults";
import type { Project } from "./config";
import { jsInputs, type ReadFile } from "./js-inputs";
import { prebuiltRn } from "./prebuilt-rn";

const BARE_HASH = /^[0-9a-f]{8,}$/i;

/** Where `computeCacheKey` keeps the native hash between runs (17-5); absent = always run the fingerprint. */
export type FingerprintMemo = { store: Store; now: number };

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
/** a module a script config can load (a local plugin, a `require` / `import`): its text may read anything */
const CODE_FILE = /\.[cm]?[jt]sx?$/;
/** the string literals of a script config */
const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g;

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

type AppConfigs = {
	/** config and `.env*` files in the root, sorted */ files: string[] /** absolute paths the config names */;
	external: string[];
};

/** What identifies a build: `key` is the cache / install hash, `native` the `@expo/fingerprint` hash (EAS indexes by it). */
export type CacheKey = { key: string; native: string /** only for JS-aware projects */; js?: string };

/**
 * Native fingerprints and the cache / install keys built on them. Every method takes its inputs (`exec`, `project`,
 * `memo`) per call, so callers share one instance.
 */
export class Fingerprint {
	/**
	 * Hash from fingerprint stdout: the whole output as JSON `{ hash }` (what `fingerprint:generate`
	 * prints), else the last non-empty line as JSON `{ hash }` or a bare hex hash.
	 */
	parseOutput(stdout: string): Result<string> {
		const whole = this.jsonHash(stdout);
		if (whole) return resultFactory.ok(whole);
		const last = stdout
			.trim()
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.at(-1);
		if (last) {
			const lineHash = this.jsonHash(last);
			if (lineHash) return resultFactory.ok(lineHash);
			if (BARE_HASH.test(last)) return resultFactory.ok(last);
		}
		return resultFactory.err(
			`could not read a fingerprint hash from output: ${stdout.trim().slice(0, 200) || "(empty)"}`
		);
	}

	/** `node_modules/.bin/fingerprint` nearest to `root` (hoisted monorepos put it at the repo root). */
	findBin(root: string, exists: (path: string) => boolean = existsSync): string | undefined {
		return nodeBin.find(root, "fingerprint", exists);
	}

	/**
	 * The fingerprint command for `platform`: the project's own `fingerprint.command` (`{platform}`
	 * substituted, run by `sh -c`), else `@expo/fingerprint` from the project's node_modules (so its
	 * `fingerprint.config.js` applies), else `bunx @expo/fingerprint`.
	 */
	argv(project: Project, platform: Platform, bin = this.findBin(project.root)): string[] {
		if (project.fingerprintCommand) {
			return ["sh", "-c", project.fingerprintCommand.replaceAll("{platform}", platform)];
		}
		const args = ["fingerprint:generate", "--platform", platform];
		return bin ? [bin, ...args] : ["bunx", "--bun", "@expo/fingerprint", ...args];
	}

	/** Compute the native fingerprint of `project` for `platform` (runs in the project root). */
	async compute(exec: Exec, project: Project, platform: Platform): AsyncResult<string> {
		const argv = this.argv(project, platform);
		const res = await exec(argv, {
			cwd: project.root,
			env: { EXPO_NO_TELEMETRY: "1" },
			timeoutMs: FINGERPRINT_TIMEOUT_MS,
		});
		if (res.exitCode !== 0) return resultFactory.err(`fingerprint failed: ${execErrors.format(argv, res)}`);
		return this.parseOutput(res.stdout);
	}

	getMemo(store: Store, project: Project, platform: Platform): FingerprintMemoRow | undefined {
		return new BuildsTable(store).getFingerprint(this.memoKey(project, platform));
	}

	/**
	 * A cheap signature of everything `@expo/fingerprint` reads (17-5): HEAD, the dirty set with each dirty
	 * path's size+mtime (editing an already-modified file keeps its status line), the submodules' commits,
	 * lockfiles and install markers from the project root up to the git toplevel, the app config files, the
	 * `.env*` files, the files the config names (icons, splash, fonts, `googleServicesFile`), and `ios/` /
	 * `android/` (symlinked config, `.env*` and named files are statted through the link too). undefined = do
	 * not memoise: not a git checkout, a dirty submodule or nested repo (its contents are invisible to the
	 * parent's status), a `fingerprint.config.*`, an app config whose inputs cannot be listed (reads the
	 * environment, a local plugin or import, a computed path), or a `.fingerprintignore` with a `!` negation
	 * (the native-dir walk hard-codes the fingerprint's default ignores, so a re-included path would be
	 * skipped; extra ignores alone keep the memo, the signature then only over-includes).
	 */
	async treeSignature(exec: Exec, root: string): Promise<string | undefined> {
		const opts = { cwd: root, timeoutMs: PROBE_TIMEOUT_MS };
		const [rev, status] = await Promise.all([
			exec(["git", "rev-parse", "--show-toplevel", "HEAD"], opts),
			exec(SIGNATURE_STATUS_ARGV, opts),
		]);
		if (rev.exitCode !== 0 || status.exitCode !== 0) return undefined;
		const [toplevel, head] = rev.stdout.trim().split("\n");
		if (!toplevel || !head) return undefined;
		const configs = this.appConfigs(root);
		if (configs === undefined) return undefined;
		const parts: string[] = [`head ${head}`, `status ${createHash("sha256").update(status.stdout).digest("hex")}`];
		const dirty = this.dirtyParts(toplevel, status.stdout);
		if (dirty === undefined) return undefined;
		parts.push(...dirty);
		const submodules = await this.submoduleParts(exec, toplevel, opts);
		if (submodules === undefined) return undefined;
		parts.push(...submodules);
		parts.push(...this.installSigs(root, toplevel));
		for (const name of configs.files) parts.push(`config ${name} ${this.statSig(join(root, name))}`);
		for (const path of configs.external) parts.push(`external ${path} ${this.statSig(path)}`);
		for (const name of ["ios", "android"]) parts.push(`native ${name} ${this.nativeDirSig(join(root, name))}`);
		return createHash("sha256").update(parts.join("\n")).digest("hex");
	}

	/**
	 * Key of a native-only Release build: the native fingerprint can't tell Debug from Release, but the
	 * binaries differ (embedded bundle, no dev client), so they must not share a cache / install key.
	 */
	releaseKey(native: string): string {
		return jsInputs.combineKey(native, "configuration:Release");
	}

	/**
	 * The cache / install key of `project`. Native projects: the native fingerprint (salted for Release). JS-aware projects
	 * (`fingerprint.include: "native+js"`): sha256 of the native fingerprint + a content hash of the
	 * `jsInputs` files, so a JS-only change is a new build (a Release binary embeds its bundle). The two
	 * halves are independent, so they are computed side by side: the JS hash (a couple of `git ls-files`)
	 * hides inside the native fingerprint's runtime. With `memo` the native hash is reused while the tree's
	 * signature is unchanged (`treeSignature`); without it (the post-build recompute) it always runs.
	 */
	async computeCacheKey(
		exec: Exec,
		project: Project,
		platform: Platform,
		readFile?: ReadFile,
		memo?: FingerprintMemo,
		env: Record<string, string | undefined> = {}
	): AsyncResult<CacheKey> {
		const [native, js] = await Promise.all([
			memo ? this.memoisedFingerprint(exec, project, platform, memo) : this.compute(exec, project, platform),
			project.jsInputs === undefined
				? undefined
				: jsInputs.hash({
						exec,
						root: project.root,
						jsInputs: project.jsInputs,
						...(readFile ? { readFile } : {}),
					}),
		]);
		if (!native.success) return native;
		const salt = await this.prebuiltRnSalt(project, platform, env, readFile ?? jsInputs.readFileOrUndefined);
		const salted = (key: string): string => (salt ? jsInputs.combineKey(key, salt) : key);
		if (js === undefined) {
			const key = project.buildConfiguration === "Release" ? this.releaseKey(native.data) : native.data;
			return resultFactory.ok({ key: salted(key), native: native.data });
		}
		if (!js.success) return js;
		return resultFactory.ok({
			key: salted(jsInputs.combineKey(native.data, js.data)),
			native: native.data,
			js: js.data,
		});
	}

	/** `{ hash }` with a non-empty string hash; a hand-written check, so zod stays off the `run` / `app` start path (15-2). */
	private jsonHash(text: string): string | undefined {
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("hash" in parsed))
				return undefined;
			return typeof parsed.hash === "string" && parsed.hash.length > 0 ? parsed.hash : undefined;
		} catch {
			return undefined;
		}
	}

	/** The memo row's key: a variant or another fingerprint command (local bin vs bunx) is its own row. */
	private memoKey(project: Project, platform: Platform): FingerprintMemoKey {
		return [project.root, platform, project.variant ?? "", JSON.stringify(this.argv(project, platform))];
	}

	private putMemo(memo: FingerprintMemo, project: Project, platform: Platform, signature: string, native: string) {
		new BuildsTable(memo.store).putFingerprint(this.memoKey(project, platform), signature, native, memo.now);
	}

	/**
	 * `@expo/fingerprint`'s default ignores under `ios/` and `android/` (its `DEFAULT_IGNORE_PATHS`), as
	 * paths relative to that dir. Anchored: `android/app/src/.../build/` is hashed by the fingerprint, so it
	 * is part of the signature too. Only the patterns that skip a whole dir (`…/**\/*`) or one file are here;
	 * `project.xcworkspace` is not, since its contents are still hashed.
	 */
	private nativeIgnored(native: string, rel: string, name: string): boolean {
		if (name === ".DS_Store" || name === ".swiftpm") return true;
		if (native === "ios")
			return (
				rel === "Pods" || rel === "build" || rel === ".xcode.env.local" || /^[^/]+\.xcworkspace\/xcuserdata$/.test(rel)
			);
		return ["build", ".cxx", ".gradle", "app/build", "app/.cxx", "app/.gradle", "gradlew.bat"].includes(rel);
	}

	/**
	 * `size:mtime:ctime` of `path`, `-` when absent (ctime moves on a restore that preserves size and mtime).
	 * A symlink also gets its realpath and the target's stat (the fingerprint hashes the target, and editing
	 * it moves neither the link nor `git status`); a dangling one reads its link text and `-`.
	 */
	private statSig(path: string): string {
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (!st) return "-";
		const own = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
		if (!st.isSymbolicLink()) return own;
		const target = statSync(path, { throwIfNoEntry: false });
		if (!target) return `${own} -> ${readlinkSync(path)} -`;
		return `${own} -> ${realpathSync(path)} ${target.size}:${target.mtimeMs}:${target.ctimeMs}`;
	}

	/** `path`'s stat through a symlink (lstat first, so a plain file costs one call); undefined when absent or dangling */
	private statThrough(path: string) {
		const st = lstatSync(path, { throwIfNoEntry: false });
		return st?.isSymbolicLink() ? statSync(path, { throwIfNoEntry: false }) : st;
	}

	/**
	 * `ios/` / `android/` (git-ignored under CNG, so `git status` cannot see them): existence, then every
	 * entry's path, size, mtime and ctime (any edit, add, delete or older-mtime restore changes it), hashed.
	 */
	private nativeDirSig(dir: string): string {
		const top = lstatSync(dir, { throwIfNoEntry: false });
		if (!top?.isDirectory()) return "-";
		const hash = createHash("sha256").update(`${top.ino}:${top.mtimeMs}:${top.ctimeMs}`);
		this.walkNative(hash, dir, dir, basename(dir));
		return hash.digest("hex");
	}

	private walkNative(hash: ReturnType<typeof createHash>, dir: string, at: string, native: string): void {
		for (const name of readdirSync(at).sort()) {
			const path = join(at, name);
			const rel = relative(dir, path);
			if (this.nativeIgnored(native, rel, name)) continue;
			const st = lstatSync(path, { throwIfNoEntry: false });
			if (!st) continue;
			hash.update(`\n${rel} ${st.size}:${st.mtimeMs}:${st.ctimeMs}`);
			if (st.isDirectory()) this.walkNative(hash, dir, path, native);
		}
	}

	/** Paths in `git status --porcelain=v1 -z` output (both sides of a rename / copy). */
	private statusPaths(raw: string): string[] {
		const tokens = raw.split("\0").filter((t) => t !== "");
		const paths: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const entry = tokens[i] ?? "";
			paths.push(entry.slice(3));
			if (/[RC]/.test(entry.slice(0, 2)) && tokens[i + 1] !== undefined) paths.push(tokens[++i] ?? "");
		}
		return paths;
	}

	/** One `dirty <path> <stat>` part per dirty path; undefined when one is a directory (a submodule or nested repo with changes). */
	private dirtyParts(toplevel: string, statusOut: string): string[] | undefined {
		const parts: string[] = [];
		for (const path of this.statusPaths(statusOut)) {
			// a submodule (or nested repo) with changes: edits inside it keep its status line and its dir's stat
			if (lstatSync(join(toplevel, path), { throwIfNoEntry: false })?.isDirectory()) return undefined;
			parts.push(`dirty ${path} ${this.statSig(join(toplevel, path))}`);
		}
		return parts;
	}

	/** The `submodules <hash>` part when the repo has submodules (none otherwise); undefined when their status cannot be read. */
	private async submoduleParts(
		exec: Exec,
		toplevel: string,
		opts: { cwd: string; timeoutMs: number }
	): Promise<string[] | undefined> {
		if (!existsSync(join(toplevel, ".gitmodules"))) return [];
		const subs = await exec(["git", "--no-optional-locks", "submodule", "status", "--recursive"], {
			...opts,
			cwd: toplevel,
		});
		if (subs.exitCode !== 0) return undefined;
		return [`submodules ${createHash("sha256").update(subs.stdout).digest("hex")}`];
	}

	/** `obj.a.b…`, undefined when any step is not an object */
	private at(value: unknown, ...keys: string[]): unknown {
		let cur = value;
		for (const k of keys) {
			if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
			cur = (cur as Record<string, unknown>)[k];
		}
		return cur;
	}

	private strings(...values: unknown[]): string[] {
		return values.flatMap((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? this.strings(...v) : []));
	}

	private isLocalModule(name: string): boolean {
		return name.startsWith("./") || name.startsWith("../") || name.startsWith("/");
	}

	/** Each config plugin's props by name; undefined when one is a local plugin (`./…`, which may read anything). */
	private pluginProps(exp: unknown): Record<string, unknown> | undefined {
		const plugins = this.at(exp, "plugins");
		const props: Record<string, unknown> = {};
		for (const entry of Array.isArray(plugins) ? plugins : []) {
			const name: unknown = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : undefined;
			if (typeof name !== "string") continue;
			if (this.isLocalModule(name)) return undefined;
			if (Array.isArray(entry)) props[name] = entry[1];
		}
		return props;
	}

	/** `expo-font`'s `android.fonts` entries given as `{ fontDefinitions: [{ path }] }` */
	private androidFontDefinitions(font: unknown): string[] {
		const fonts = this.at(font, "android", "fonts");
		if (!Array.isArray(fonts)) return [];
		return fonts.flatMap((f) => {
			const defs = this.at(f, "fontDefinitions");
			return Array.isArray(defs) ? this.strings(...defs.map((d) => this.at(d, "path"))) : [];
		});
	}

	/**
	 * The files `@expo/fingerprint` hashes as `expoConfigExternalFile` for an `app.json` (icons, adaptive
	 * icon, `expo-splash-screen` / `expo-font` plugin props, `googleServicesFile`; both platforms), resolved
	 * against `root`. undefined = not memoisable: unparsable, or a local config plugin.
	 */
	private appJsonExternals(root: string, text: string): string[] | undefined {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return undefined;
		}
		const exp = this.at(parsed, "expo") ?? parsed;
		const props = this.pluginProps(exp);
		if (props === undefined) return undefined;
		const splash = props["expo-splash-screen"];
		const font = props["expo-font"];
		const densities = ["image", "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
		const files = this.strings(
			this.at(exp, "icon"),
			this.at(exp, "android", "icon"),
			this.at(exp, "ios", "icon"),
			this.at(exp, "ios", "icon", "light"),
			this.at(exp, "ios", "icon", "dark"),
			this.at(exp, "ios", "icon", "tinted"),
			this.at(exp, "android", "adaptiveIcon", "foregroundImage"),
			this.at(exp, "android", "adaptiveIcon", "backgroundImage"),
			this.at(exp, "android", "googleServicesFile"),
			this.at(exp, "ios", "googleServicesFile"),
			this.at(splash, "image"),
			this.at(splash, "dark", "image"),
			...densities.flatMap((d) => [this.at(splash, "android", d), this.at(splash, "android", "dark", d)]),
			...["image", "tabletImage"].flatMap((k) => [this.at(splash, "ios", k), this.at(splash, "ios", "dark", k)]),
			this.at(font, "fonts"),
			this.at(font, "ios", "fonts"),
			this.at(font, "android", "fonts"),
			this.androidFontDefinitions(font)
		);
		return files.map((f) => resolve(root, f));
	}

	/**
	 * What a script config (`app.config.ts`…) reads, from its string literals: each one naming a file
	 * (`./assets/icon.png`, `assets/icon.png`, an absolute path) is statted. undefined = not memoisable:
	 * it reads the environment, computes a path, or names a `./…` module (a local plugin, an import: a path that
	 * does not exist as a file, or a code file `.js`/`.ts`/…) or dir. Literals are classified through symlinks.
	 */
	private scriptExternals(root: string, text: string): string[] | undefined {
		if (READS_ENV.test(text) || COMPUTES_PATHS.test(text)) return undefined;
		const files: string[] = [];
		for (const m of text.matchAll(STRING_LITERAL)) {
			const lit = m[1] ?? m[2] ?? m[3] ?? "";
			if (lit === "") continue;
			const found = this.scriptLiteral(root, lit);
			if (found === "opaque") return undefined;
			if (found !== undefined) files.push(found);
		}
		return files;
	}

	/** One script-config literal: the file it names, `opaque` when it is a module or dir, undefined when neither. */
	private scriptLiteral(root: string, lit: string): string | "opaque" | undefined {
		const path = resolve(root, lit);
		const st = this.statThrough(path);
		if (st?.isFile()) {
			// a local plugin or module (`./plugins/withFoo.js`, `require("./base.config.js")`): evaluated by the config
			return this.isLocalModule(lit) && CODE_FILE.test(path) ? "opaque" : path;
		}
		if (this.isLocalModule(lit)) return "opaque";
		return st?.isDirectory() && lit !== "ios" && lit !== "android" ? "opaque" : undefined;
	}

	/** a `.fingerprintignore` line `!…` re-includes a path the fingerprint ignores by default */
	private hasNegation(text: string): boolean {
		return text.split("\n").some((line) => line.trim().startsWith("!"));
	}

	/** The app config and `.env*` files in `root` plus the files the config names; undefined = do not memoise. */
	private appConfigs(root: string): AppConfigs | undefined {
		const names = readdirSync(root).sort();
		if (names.some((n) => FINGERPRINT_CONFIG.test(n))) return undefined;
		if (
			names.includes(".fingerprintignore") &&
			this.hasNegation(readFileSync(join(root, ".fingerprintignore"), "utf8"))
		)
			return undefined;
		const files = names.filter((n) => APP_CONFIG.test(n) || ENV_FILE.test(n));
		const external: string[] = [];
		for (const name of names.filter((n) => APP_CONFIG.test(n) && n !== ".fingerprintignore")) {
			const text = readFileSync(join(root, name), "utf8");
			const found = name.endsWith(".json") ? this.appJsonExternals(root, text) : this.scriptExternals(root, text);
			if (found === undefined) return undefined;
			for (const path of found) {
				// a dir (a fonts folder): edits inside it do not move its stat
				if (this.statThrough(path)?.isDirectory()) return undefined;
				external.push(path);
			}
		}
		return { files, external: [...new Set(external)].sort() };
	}

	/** Lockfiles and install markers in `root` and each parent up to the git `toplevel` (hoisted monorepos). */
	private installSigs(root: string, toplevel: string): string[] {
		const sigs: string[] = [];
		// both resolved: git prints the toplevel resolved and the root may come through a symlink (or the other way
		// round, e.g. macOS's /var → /private/var tmpdir), and the walk must reach the toplevel either way
		const start = realpathSync(root);
		const top = realpathSync(toplevel);
		for (let dir = start; ; dir = dirname(dir)) {
			for (const name of [...LOCKFILES, ...INSTALL_MARKERS]) {
				sigs.push(`${relative(start, dir) || "."}/${name} ${this.statSig(join(dir, name))}`);
			}
			if (dir === top || relative(top, dir).startsWith("..") || dirname(dir) === dir) return sigs;
		}
	}

	/** `treeSignature`, with an unreadable tree (permissions, a racing delete) meaning "do not memoise". */
	private async signatureOrUndefined(exec: Exec, root: string): Promise<string | undefined> {
		try {
			return await this.treeSignature(exec, root);
		} catch {
			return undefined;
		}
	}

	/**
	 * The native fingerprint, from the memo when the tree's signature is the one it was computed at. A
	 * project `fingerprint.command` is opaque (it may read anything), so it always runs. The signature is
	 * taken again after a run and the result kept only when nothing moved meanwhile.
	 */
	private async memoisedFingerprint(
		exec: Exec,
		project: Project,
		platform: Platform,
		memo: FingerprintMemo
	): AsyncResult<string> {
		if (project.fingerprintCommand) return this.compute(exec, project, platform);
		const before = await this.signatureOrUndefined(exec, project.root);
		if (before === undefined) return this.compute(exec, project, platform);
		const row = this.getMemo(memo.store, project, platform);
		if (row?.signature === before) return resultFactory.ok(row.native);
		const fresh = await this.compute(exec, project, platform);
		if (!fresh.success) return fresh;
		if ((await this.signatureOrUndefined(exec, project.root)) === before)
			this.putMemo(memo, project, platform, before, fresh.data);
		return fresh;
	}

	/** Salt of an iOS build that opts into React Native's precompiled core: it changes the native output (see `PrebuiltRn.plan`). */
	private async prebuiltRnSalt(
		project: Project,
		platform: Platform,
		env: Record<string, string | undefined>,
		readFile: ReadFile
	): Promise<string | undefined> {
		const plan = await prebuiltRn.plan({
			platform,
			projectRoot: project.root,
			optOut: project.prebuiltReactNative === false,
			env,
			readFile,
		});
		return plan.salt;
	}
}

export const fingerprint = new Fingerprint();
