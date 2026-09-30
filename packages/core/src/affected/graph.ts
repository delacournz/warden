import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type ts from "typescript";
import type { Platform } from "../types";
import { type ImportCache, openImportCache } from "./cache";

/** Files whose imports are followed; anything else (images, fonts, json…) is a leaf. */
const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const LAYOUT_EXT = [".tsx", ".ts", ".jsx", ".js"];

export type GraphOptions = {
	platform: Platform;
	/** files outside this dir (and anything under node_modules) are not followed */
	repoRoot: string;
	/** used for files with no tsconfig.json between them and `repoRoot` */
	fallbackTsconfig?: string;
	cache?: ImportCache;
};

/** Resolved imports of one file: absolute paths inside the repo. */
export type ImportGraph = { imports: (file: string) => string[]; save: () => void };

type TsConfig = { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache };

let tsModule: typeof ts | undefined;

/** TypeScript is big: loaded on the first graph, not at CLI start. */
async function loadTs(): Promise<typeof ts> {
	tsModule ??= (await import("typescript")).default;
	return tsModule;
}

const within = (dir: string, file: string) => {
	const rel = relative(dir, file);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Nearest `tsconfig.json` from `dir` up to `repoRoot`, memoised per directory. */
function nearestTsconfig(dir: string, repoRoot: string, memo: Map<string, string | undefined>): string | undefined {
	if (memo.has(dir)) return memo.get(dir);
	const candidate = join(dir, "tsconfig.json");
	const atTop = dir === repoRoot || dirname(dir) === dir;
	const found = existsSync(candidate) ? candidate : atTop ? undefined : nearestTsconfig(dirname(dir), repoRoot, memo);
	memo.set(dir, found);
	return found;
}

/** Where `spec` could point through tsconfig `paths` (`@/assets/*` → `./src/assets/*`). */
function pathsCandidates(spec: string, options: ts.CompilerOptions): string[] {
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

/** A non-code import (`./logo.png`, `@/assets/x.png`): relative or via `paths`, with platform/scale variants. */
function resolveAsset(
	spec: string,
	from: string,
	options: ts.CompilerOptions,
	suffixes: readonly string[]
): string | undefined {
	const candidates = [
		...(spec.startsWith(".") ? [resolve(dirname(from), spec)] : []),
		...pathsCandidates(spec, options),
	];
	for (const path of candidates) {
		const ext = extname(path);
		const stem = path.slice(0, path.length - ext.length);
		const variants = [...suffixes.map((s) => `${stem}${s}${ext}`), `${stem}@2x${ext}`, `${stem}@3x${ext}`];
		const hit = variants.find((v) => existsSync(v));
		if (hit) return hit;
	}
	return undefined;
}

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

const transpilers = new Map<string, Bun.Transpiler>();

/**
 * Imports that exist at runtime: `import type` / `export type` are erased, as the bundler's
 * TypeScript transform does. undefined = not parseable (the caller falls back to TypeScript's scanner).
 */
function runtimeImports(file: string, text: string): string[] | undefined {
	const loader = LOADERS[extname(file)];
	if (!loader) return undefined;
	let transpiler = transpilers.get(loader);
	if (!transpiler) {
		transpiler = new Bun.Transpiler({ loader });
		transpilers.set(loader, transpiler);
	}
	try {
		return transpiler.scanImports(text).map((i) => i.path);
	} catch {
		return undefined;
	}
}

/** RN resolution order for `platform`: `x.ios.tsx`, then `x.native.tsx`, then `x.tsx`. */
export function platformSuffixes(platform: Platform): string[] {
	return [`.${platform}`, ".native", ""];
}

/**
 * Import graph for one platform, resolved the way the TypeScript compiler does it: each file's
 * nearest tsconfig (`paths`, `baseUrl`, `extends`, `customConditions`), workspace symlinks
 * followed to their real path, and React Native platform files via `moduleSuffixes`.
 */
export async function createImportGraph(opts: GraphOptions): Promise<ImportGraph> {
	const ts = await loadTs();
	const repoRoot = real(opts.repoRoot);
	const cache = opts.cache ?? openImportCache();
	const suffixes = platformSuffixes(opts.platform);
	const configs = new Map<string, TsConfig>();
	const nearest = new Map<string, string | undefined>();
	const resolved = new Map<string, string[]>();
	const host: ts.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };

	const parseConfig = (path: string): TsConfig => {
		const hit = configs.get(path);
		if (hit) return hit;
		const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, host);
		const options: ts.CompilerOptions = {
			...(parsed?.options ?? {}),
			allowJs: true,
			resolveJsonModule: true,
			moduleSuffixes: suffixes,
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
		configs.set(path, config);
		return config;
	};

	const tsconfigFor = (file: string): TsConfig => {
		const found = nearestTsconfig(dirname(file), repoRoot, nearest) ?? opts.fallbackTsconfig;
		return parseConfig(found ?? join(repoRoot, "tsconfig.json"));
	};

	const specifiers = (file: string): string[] => {
		const hit = cache.get(file);
		if (hit) return hit;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return [];
		}
		const specs =
			runtimeImports(file, text) ?? ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
		cache.set(file, specs);
		return specs;
	};

	/** `spec` imported by `file` → its real path, when it is a repo file outside node_modules. */
	const resolveSpec = (spec: string, file: string, config: TsConfig): string | undefined => {
		const res = ts.resolveModuleName(spec, file, config.options, ts.sys, config.cache).resolvedModule;
		const target = res?.resolvedFileName ?? resolveAsset(spec, file, config.options, suffixes);
		if (target === undefined) return undefined;
		const path = real(target);
		return within(repoRoot, path) && !path.split(sep).includes("node_modules") ? path : undefined;
	};

	const imports = (file: string): string[] => {
		const hit = resolved.get(file);
		if (hit) return hit;
		const out = new Set<string>();
		if (CODE_EXT.has(extname(file))) {
			const config = tsconfigFor(file);
			for (const spec of specifiers(file)) {
				const target = resolveSpec(spec, file, config);
				if (target !== undefined) out.add(target);
			}
		}
		const list = [...out];
		resolved.set(file, list);
		return list;
	};

	return { imports, save: () => cache.save() };
}

/**
 * BFS from `entries` over `imports`: every reachable file → the file that first imported it
 * (entries → null). `maxDepth` stops following imports more than that many hops from an entry.
 */
export function reachable(
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
export function chainTo(parents: ReadonlyMap<string, string | null>, file: string): string[] {
	const chain: string[] = [];
	for (let at: string | null | undefined = file; at != null; at = parents.get(at)) chain.unshift(at);
	return chain;
}

/**
 * File-based routers render every `_layout` above a route: those (per-platform variants included)
 * count as entries of a route inside `routerRoot`.
 */
export function routerLayouts(entry: string, routerRoot: string, platform: Platform): string[] {
	if (!within(routerRoot, entry)) return [];
	const out: string[] = [];
	for (let dir = dirname(entry); ; dir = dirname(dir)) {
		for (const suffix of platformSuffixes(platform)) {
			const hit = LAYOUT_EXT.map((ext) => join(dir, `_layout${suffix}${ext}`)).find((p) => existsSync(p));
			if (hit) {
				out.push(hit);
				break;
			}
		}
		if (dir === routerRoot || !within(routerRoot, dir)) break;
	}
	return out.filter((p) => p !== entry);
}
