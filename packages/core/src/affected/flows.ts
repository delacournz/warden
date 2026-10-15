import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Platform } from "../types";
import type { E2eFlowConfig } from "./affected.schema";

/**
 * A flow file under `flowsDir`. `id` = its path below `flowsDir` without the extension (`qa/login`).
 * `*.e2e.ts(x)` files are `e2e` flows, any other `.ts(x)` is a `fragment` (a helper); `runs` are the
 * relative imports, so a helper change selects every flow that imports it.
 */
export type Flow = {
	id: string;
	file: string;
	kind: "e2e" | "fragment";
	/** absolute paths of the files this one imports (directly) that exist on disk */
	runs: string[];
};

export type FlowScan = { flows: Flow[]; warnings: string[] };

const TS_FLOW = /\.e2e\.tsx?$/;
const TS_FILE = /(?<!\.d)\.tsx?$/;
const TS_EXTENSIONS = [".ts", ".tsx"];
const SKIP_DIR = /^(\.|__baselines__$|node_modules$)/;

function walk(dir: string, out: string[]): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIR.test(entry.name)) walk(path, out);
		} else if (TS_FILE.test(entry.name)) {
			out.push(path);
		}
	}
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

/** `./x` → the first existing `./x`, `./x.ts(x)`, `./x/index.ts(x)`; undefined when none does. */
function resolveRelative(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	const candidates = [
		base,
		...TS_EXTENSIONS.map((ext) => base + ext),
		...TS_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
	];
	return candidates.find(isFile);
}

const tsTranspiler = new Bun.Transpiler({ loader: "tsx" });

/** One flow file → its kind and the relative, value-level imports (that exist on disk) as `runs`. */
export function parseFlow(file: string, flowsDir: string, text: string): Flow {
	const runs = tsTranspiler
		.scanImports(text)
		.map((i) => i.path)
		.filter((spec) => spec.startsWith("."))
		.flatMap((spec) => resolveRelative(file, spec) ?? []);
	return {
		id: relative(flowsDir, file).replace(TS_FLOW, "").replace(TS_FILE, ""),
		file,
		kind: TS_FLOW.test(file) ? "e2e" : "fragment",
		runs: [...new Set(runs)],
	};
}

/** All `.ts(x)` files below `flowsDir` (skipping dot dirs and screenshot baselines), sorted by id. */
export function scanFlows(flowsDir: string): FlowScan {
	const files: string[] = [];
	walk(flowsDir, files);
	const flows: Flow[] = [];
	const warnings: string[] = [];
	for (const file of files.sort()) {
		try {
			flows.push(parseFlow(file, flowsDir, readFileSync(file, "utf8")));
		} catch (error) {
			warnings.push(`${relative(flowsDir, file)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { flows, warnings };
}

const PLATFORM_TOKEN = /(?:^|[-_/.])(ios|android)(?:[-_/.]|$)/;

/** A flow's config: exact id first, then every matching glob in order; lists are merged. */
export type FlowSettings = {
	entries: string[];
	paths: string[];
	platforms?: Platform[];
	required?: boolean;
	maxDepth?: number;
};

export function flowSettings(id: string, flows: Record<string, E2eFlowConfig>): FlowSettings {
	const matches = Object.entries(flows)
		.filter(([key]) => key === id || new Bun.Glob(key).match(id))
		.sort(([a], [b]) => Number(b === id) - Number(a === id));
	const settings: FlowSettings = { entries: [], paths: [] };
	for (const [, cfg] of matches) {
		settings.entries.push(...cfg.entries);
		settings.paths.push(...cfg.paths);
		if (settings.platforms === undefined && cfg.platforms) settings.platforms = cfg.platforms;
		if (settings.required === undefined && cfg.required !== undefined) settings.required = cfg.required;
		if (settings.maxDepth === undefined && cfg.maxDepth !== undefined) settings.maxDepth = cfg.maxDepth;
	}
	return settings;
}

/** Platforms a flow runs on: config, else an `ios`/`android` token in its id, else both. */
export function flowPlatforms(flow: Flow, settings: FlowSettings): Platform[] {
	if (settings.platforms) return settings.platforms;
	const token = PLATFORM_TOKEN.exec(flow.id)?.[1];
	if (token === "ios" || token === "android") return [token];
	return ["ios", "android"];
}
