import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import type ts from "typescript";
import { type ImportCache, importCaches } from "./cache";

/** Files whose imports are followed; anything else (images, fonts, json…) is a leaf. */
const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
/** Extensions of a file-based route or layout, in the order they are tried. */
export const LAYOUT_EXT = [".tsx", ".ts", ".jsx", ".js"];

export type GraphOptions = {
	platform: Platform;
	/** files outside this dir (and anything under node_modules) are not followed */
	repoRoot: string;
	/** used for files with no tsconfig.json between them and `repoRoot` */
	fallbackTsconfig?: string;
	cache?: ImportCache;
	/** where the compiler is, undefined: none. Default: `typescriptResolver.resolve` */
	typescript?: (repoRoot: string) => string | undefined;
};

/** Resolved imports of one file: absolute paths inside the repo. */
export type ImportGraph = { imports: (file: string) => string[]; save: () => void };

type TsConfig = { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache };

/** What `warden affected` says (after its own prefix) when it cannot find a TypeScript compiler for the project it analyses. */
export const TYPESCRIPT_MISSING = "needs typescript in the analysed project: add it as a devDependency";

/**
 * The graph walker's exit code (`__affected-graph`, `graph-worker.ts`) when there is no usable compiler, the reason on
 * stderr: the caller reports it instead of redoing the walk in its own process, which would fail the same way.
 */
export const TYPESCRIPT_UNUSABLE_EXIT = 4;

/** The oldest compiler the walk can use: `moduleSuffixes` (RN platform files) is 4.7, `ModuleResolutionKind.Bundler` is 5.0. */
const MIN_TYPESCRIPT_MAJOR = 5;

/** The compiler API the walk calls. */
const TS_API = [
	"preProcessFile",
	"resolveModuleName",
	"getParsedCommandLineOfConfigFile",
	"createModuleResolutionCache",
] as const;

const LOADERS: Record<string, "ts" | "tsx" | "jsx" | "js"> = {
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "tsx",
	".js": "jsx",
	".jsx": "jsx",
	".mjs": "js",
	".cjs": "js",
};

/** Finding, vetting and loading the TypeScript compiler a graph walk uses. */
export class TypescriptResolver {
	/** `TYPESCRIPT_MISSING` with where it looked (Yarn PnP has no node_modules, so it never resolves there). */
	missing(repoRoot: string): string {
		return `${TYPESCRIPT_MISSING} (looked for node_modules/typescript from ${resolve(repoRoot)} upward; Yarn PnP is not supported)`;
	}

	/**
	 * Why the compiler at `entry` cannot be used, judged by its package.json `version` alone (no import: the CLI process
	 * does not load the compiler just to check it). undefined: fine, or no version to read.
	 */
	versionProblem(entry: string): string | undefined {
		for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
			let pkg: { name?: unknown; version?: unknown };
			try {
				pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			} catch {
				continue;
			}
			if (pkg.name !== "typescript") continue;
			return typeof pkg.version === "string" ? typescriptLoader.tooOld(pkg.version, entry) : undefined;
		}
		return undefined;
	}

	/**
	 * The TypeScript compiler a graph walk loads: warden's own (`own`, default: the one beside warden's source, pinned by
	 * warden's lockfile) when it resolves, else the analysed project's (the nearest `node_modules/typescript` from
	 * `repoRoot` upward), else undefined. The compiled binary is built with `--external typescript` (the 28 MB it would
	 * otherwise carry for this one walk), so there only the project's resolves. The lookup reads node_modules itself: a
	 * Bun-compiled binary resolves no packages from disk (`createRequire(...).resolve` and `Bun.resolveSync` both fail
	 * there), but it does import an absolute path.
	 */
	resolve(repoRoot: string, own: () => string | undefined = () => this.besideWarden()): string | undefined {
		const mine = own();
		if (mine !== undefined) return mine;
		for (let dir = resolve(repoRoot); ; dir = dirname(dir)) {
			const entry = this.typescriptIn(dir);
			if (entry !== undefined) return entry;
			if (dirname(dir) === dir) return undefined;
		}
	}

	/** The typescript beside warden's own source (source mode); none in a compiled binary, which leaves it out. */
	private besideWarden(): string | undefined {
		try {
			return Bun.resolveSync("typescript", import.meta.dir);
		} catch {
			return undefined;
		}
	}

	/** `<dir>/node_modules/typescript`'s entry file (its `main`, else `index.js`), when that file exists. */
	private typescriptIn(dir: string): string | undefined {
		const pkgDir = join(dir, "node_modules", "typescript");
		let main = "index.js";
		try {
			const pkg: { main?: unknown } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
			if (typeof pkg.main === "string") main = pkg.main;
		} catch {
			return undefined;
		}
		const entry = resolve(pkgDir, main);
		return existsSync(entry) ? entry : undefined;
	}
}

export const typescriptResolver = new TypescriptResolver();

/** Loads (and memoises) the TypeScript compiler module. Not exported: its types stay out of the published declarations. */
class TypescriptLoader {
	private readonly modules = new Map<string, Result<typeof ts>>();

	/** TypeScript is big: loaded on the first graph, not at CLI start. An error when none resolves or it is not usable. */
	async load(repoRoot: string, lookup: (repoRoot: string) => string | undefined): AsyncResult<typeof ts> {
		const path = lookup(repoRoot);
		if (path === undefined) return resultFactory.err(typescriptResolver.missing(repoRoot));
		const known = this.modules.get(path);
		if (known) return known;
		let loaded: Result<typeof ts>;
		try {
			const mod: { default?: unknown } = await import(path);
			const api = (mod.default ?? mod) as Record<string, unknown>;
			const problem = this.unusable(api, path);
			loaded = problem === undefined ? resultFactory.ok(api as unknown as typeof ts) : resultFactory.err(problem);
		} catch (error) {
			loaded = resultFactory.err(
				`typescript at ${path} failed to load: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		this.modules.set(path, loaded);
		return loaded;
	}

	tooOld(version: string, path: string): string | undefined {
		const major = Number.parseInt(version, 10);
		return Number.isFinite(major) && major < MIN_TYPESCRIPT_MAJOR
			? `typescript ${version} at ${path} is too old: warden affected needs ${MIN_TYPESCRIPT_MAJOR}.0 or later`
			: undefined;
	}

	/** Why the module loaded from `path` is not a compiler the walk can use, undefined: it is. */
	private unusable(mod: Record<string, unknown>, path: string): string | undefined {
		const version = typeof mod.versionMajorMinor === "string" ? mod.versionMajorMinor : "of unknown version";
		const missing = TS_API.filter((name) => typeof mod[name] !== "function");
		if (missing.length > 0)
			return `typescript ${version} at ${path} is not a TypeScript compiler (no ${missing.join(", ")})`;
		return this.tooOld(version, path);
	}
}

const typescriptLoader = new TypescriptLoader();

/** Path containment and symlink helpers shared by the walk and the router layouts. */
class RepoPaths {
	within(dir: string, file: string): boolean {
		const rel = relative(dir, file);
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	}

	real(path: string): string {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	}
}

const repoPaths = new RepoPaths();

/** `import` specifiers that exist at runtime, scanned with Bun's transpiler (one per loader, kept). */
class RuntimeImports {
	private readonly transpilers = new Map<string, Bun.Transpiler>();

	/**
	 * Imports that exist at runtime: `import type` / `export type` are erased, as the bundler's
	 * TypeScript transform does. undefined = not parseable (the caller falls back to TypeScript's scanner).
	 */
	scan(file: string, text: string): string[] | undefined {
		const loader = LOADERS[extname(file)];
		if (!loader) return undefined;
		let transpiler = this.transpilers.get(loader);
		if (!transpiler) {
			transpiler = new Bun.Transpiler({ loader });
			this.transpilers.set(loader, transpiler);
		}
		try {
			return transpiler.scanImports(text).map((i) => i.path);
		} catch {
			return undefined;
		}
	}
}

const runtimeImports = new RuntimeImports();

/** One platform's walk state: parsed tsconfigs, memoised lookups and the resolved imports per file. */
class ImportWalk implements ImportGraph {
	private readonly configs = new Map<string, TsConfig>();
	private readonly nearest = new Map<string, string | undefined>();
	private readonly resolved = new Map<string, string[]>();
	private readonly host: ts.ParseConfigFileHost;

	constructor(
		private readonly ts: typeof import("typescript"),
		private readonly opts: GraphOptions,
		private readonly repoRoot: string,
		private readonly cache: ImportCache,
		private readonly suffixes: readonly string[]
	) {
		this.host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
	}

	readonly imports = (file: string): string[] => {
		const hit = this.resolved.get(file);
		if (hit) return hit;
		const out = new Set<string>();
		if (CODE_EXT.has(extname(file))) {
			const config = this.tsconfigFor(file);
			for (const spec of this.specifiers(file)) {
				const target = this.resolveSpec(spec, file, config);
				if (target !== undefined) out.add(target);
			}
		}
		const list = [...out];
		this.resolved.set(file, list);
		return list;
	};

	readonly save = (): void => this.cache.save();

	private parseConfig(path: string): TsConfig {
		const hit = this.configs.get(path);
		if (hit) return hit;
		const { ts } = this;
		const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, this.host);
		const options: ts.CompilerOptions = {
			...(parsed?.options ?? {}),
			allowJs: true,
			resolveJsonModule: true,
			moduleSuffixes: [...this.suffixes],
			// source files, not a package's built `.d.ts`, are what the app bundles
			noDtsResolution: true,
		};
		const kind = options.moduleResolution;
		const conditional =
			kind === ts.ModuleResolutionKind.Bundler ||
			kind === ts.ModuleResolutionKind.Node16 ||
			kind === ts.ModuleResolutionKind.NodeNext;
		if (conditional) options.customConditions = [...(options.customConditions ?? []), "react-native"];
		const config = {
			options,
			cache: ts.createModuleResolutionCache(dirname(path), (f) => f, options),
		};
		this.configs.set(path, config);
		return config;
	}

	private tsconfigFor(file: string): TsConfig {
		const found = this.nearestTsconfig(dirname(file)) ?? this.opts.fallbackTsconfig;
		return this.parseConfig(found ?? join(this.repoRoot, "tsconfig.json"));
	}

	/** Nearest `tsconfig.json` from `dir` up to `repoRoot`, memoised per directory. */
	private nearestTsconfig(dir: string): string | undefined {
		if (this.nearest.has(dir)) return this.nearest.get(dir);
		const candidate = join(dir, "tsconfig.json");
		const atTop = dir === this.repoRoot || dirname(dir) === dir;
		const found = existsSync(candidate) ? candidate : atTop ? undefined : this.nearestTsconfig(dirname(dir));
		this.nearest.set(dir, found);
		return found;
	}

	private specifiers(file: string): string[] {
		const hit = this.cache.get(file);
		if (hit) return hit;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return [];
		}
		const specs =
			runtimeImports.scan(file, text) ?? this.ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
		this.cache.set(file, specs);
		return specs;
	}

	/** `spec` imported by `file` → its real path, when it is a repo file outside node_modules. */
	private resolveSpec(spec: string, file: string, config: TsConfig): string | undefined {
		const res = this.ts.resolveModuleName(spec, file, config.options, this.ts.sys, config.cache).resolvedModule;
		const target = res?.resolvedFileName ?? this.resolveAsset(spec, file, config.options);
		if (target === undefined) return undefined;
		const path = repoPaths.real(target);
		return repoPaths.within(this.repoRoot, path) && !path.split(sep).includes("node_modules") ? path : undefined;
	}

	/** A non-code import (`./logo.png`, `@/assets/x.png`): relative or via `paths`, with platform/scale variants. */
	private resolveAsset(spec: string, from: string, options: ts.CompilerOptions): string | undefined {
		const candidates = [
			...(spec.startsWith(".") ? [resolve(dirname(from), spec)] : []),
			...this.pathsCandidates(spec, options),
		];
		for (const path of candidates) {
			const ext = extname(path);
			const stem = path.slice(0, path.length - ext.length);
			const variants = [...this.suffixes.map((s) => `${stem}${s}${ext}`), `${stem}@2x${ext}`, `${stem}@3x${ext}`];
			const hit = variants.find((v) => existsSync(v));
			if (hit) return hit;
		}
		return undefined;
	}

	/** Where `spec` could point through tsconfig `paths` (`@/assets/*` → `./src/assets/*`). */
	private pathsCandidates(spec: string, options: ts.CompilerOptions): string[] {
		const base = options.baseUrl ?? (typeof options.pathsBasePath === "string" ? options.pathsBasePath : undefined);
		if (base === undefined) return [];
		return Object.entries(options.paths ?? {}).flatMap(([pattern, targets]) => {
			const star = pattern.indexOf("*");
			if (star === -1) return spec === pattern ? targets.map((t) => resolve(base, t)) : [];
			const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
			if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return [];
			const captured = spec.slice(prefix.length, spec.length - suffix.length);
			return targets.map((t) => resolve(base, t.replace("*", captured)));
		});
	}
}

export class ImportGraphs {
	/** RN resolution order for `platform`: `x.ios.tsx`, then `x.native.tsx`, then `x.tsx`. */
	platformSuffixes(platform: Platform): string[] {
		return [`.${platform}`, ".native", ""];
	}

	/**
	 * Import graph for one platform, resolved the way the TypeScript compiler does it: each file's
	 * nearest tsconfig (`paths`, `baseUrl`, `extends`, `customConditions`), workspace symlinks
	 * followed to their real path, and React Native platform files via `moduleSuffixes`.
	 */
	async create(opts: GraphOptions): AsyncResult<ImportGraph> {
		const loaded = await typescriptLoader.load(
			opts.repoRoot,
			opts.typescript ?? ((root) => typescriptResolver.resolve(root))
		);
		if (!loaded.success) return loaded;
		const cache = opts.cache ?? importCaches.open();
		const suffixes = this.platformSuffixes(opts.platform);
		return resultFactory.ok(new ImportWalk(loaded.data, opts, repoPaths.real(opts.repoRoot), cache, suffixes));
	}

	/**
	 * BFS from `entries` over `imports`: every reachable file → the file that first imported it
	 * (entries → null). `maxDepth` stops following imports more than that many hops from an entry.
	 */
	reachable(
		entries: readonly string[],
		imports: (file: string) => string[],
		maxDepth = Number.POSITIVE_INFINITY
	): Map<string, string | null> {
		const parent = new Map<string, string | null>();
		let frontier = entries.filter((entry, i) => entries.indexOf(entry) === i);
		for (const entry of frontier) parent.set(entry, null);
		for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
			const next: string[] = [];
			for (const file of frontier) {
				for (const target of imports(file)) {
					if (parent.has(target)) continue;
					parent.set(target, file);
					next.push(target);
				}
			}
			frontier = next;
		}
		return parent;
	}

	/** Entry → … → `file`, along the BFS parents (shortest import chain). */
	chainTo(parents: ReadonlyMap<string, string | null>, file: string): string[] {
		const chain: string[] = [];
		for (let at: string | null | undefined = file; at != null; at = parents.get(at)) chain.unshift(at);
		return chain;
	}

	/**
	 * File-based routers render every `_layout` above a route: those (per-platform variants included)
	 * count as entries of a route inside `routerRoot`.
	 */
	routerLayouts(entry: string, routerRoot: string, platform: Platform): string[] {
		if (!repoPaths.within(routerRoot, entry)) return [];
		const out: string[] = [];
		for (let dir = dirname(entry); ; dir = dirname(dir)) {
			for (const suffix of this.platformSuffixes(platform)) {
				const hit = LAYOUT_EXT.map((ext) => join(dir, `_layout${suffix}${ext}`)).find((p) => existsSync(p));
				if (hit) {
					out.push(hit);
					break;
				}
			}
			if (dir === routerRoot || !repoPaths.within(routerRoot, dir)) break;
		}
		return out.filter((p) => p !== entry);
	}
}

export const importGraphs = new ImportGraphs();
