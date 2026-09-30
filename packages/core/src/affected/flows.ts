import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Platform } from "../types";
import type { E2eFlowConfig } from "./affected.schema";

/**
 * A flow file under `flowsDir`. `id` = its path below `flowsDir` without the extension (`qa/login`).
 * `e2e` flows start with a `launch` step and are runnable on their own; `fragment`s are pulled in by `run:`.
 */
export type Flow = {
	id: string;
	file: string;
	kind: "e2e" | "fragment";
	/** absolute paths of the flow files this one `run:`s (directly) */
	runs: string[];
	/** platforms named by a per-platform `launch: { ios, android }` map */
	launchPlatforms?: Platform[];
};

export type FlowScan = { flows: Flow[]; warnings: string[] };

const FLOW_FILE = /\.ya?ml$/;
const SKIP_DIR = /^(\.|__baselines__$|node_modules$)/;
const PASSIVE_STEPS = new Set(["echo", "script"]);

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
		} else if (FLOW_FILE.test(entry.name)) {
			out.push(path);
		}
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Every `run:` target in `steps`, including the ones nested in `when: … steps:`. */
function runTargets(steps: unknown, out: string[]): void {
	if (!Array.isArray(steps)) return;
	for (const step of steps) {
		if (!isRecord(step)) continue;
		if (typeof step.run === "string") out.push(step.run);
		if (isRecord(step.when)) runTargets(step.when.steps, out);
		runTargets(step.steps, out);
	}
}

function launchPlatforms(launch: unknown): Platform[] | undefined {
	if (!isRecord(launch)) return undefined;
	const platforms = (["ios", "android"] as const).filter((p) => p in launch);
	return platforms.length > 0 ? platforms : undefined;
}

const STEP = /^\s*-\s+([A-Za-z-]+):\s*(.*)$/;
const RUN = /^\s*(?:-\s+)?run:\s*["']?([^"'\s#]+)/;

/**
 * Line scan for files the strict YAML parser rejects (the flow runner is more lenient, e.g. `: `
 * inside a multi-line plain scalar): top-level step keys, the `launch` map's platform keys, `run:` refs.
 */
function scanSteps(text: string): unknown[] {
	const steps: unknown[] = [];
	for (const line of text.split(/\r?\n/)) {
		const run = RUN.exec(line);
		if (run?.[1]) steps.push({ run: run[1] });
		const step = STEP.exec(line);
		if (!step?.[1] || step[1] === "run") continue;
		const value = step[2] ?? "";
		const platforms = (["ios", "android"] as const).filter((p) => new RegExp(`\\b${p}\\s*:`).test(value));
		steps.push({ [step[1]]: platforms.length > 0 ? Object.fromEntries(platforms.map((p) => [p, true])) : value });
	}
	return steps;
}

function parseSteps(text: string): unknown[] {
	try {
		const doc: unknown = Bun.YAML.parse(text);
		return isRecord(doc) && Array.isArray(doc.steps) ? doc.steps : [];
	} catch {
		return scanSteps(text);
	}
}

/** One flow file → its kind, `run:` refs and launch platforms. */
export function parseFlow(file: string, flowsDir: string, text: string): Flow {
	const id = relative(flowsDir, file).replace(FLOW_FILE, "");
	const steps = parseSteps(text);
	const first = steps.find((s) => !(isRecord(s) && Object.keys(s).some((k) => PASSIVE_STEPS.has(k))));
	const launch = isRecord(first) ? first.launch : undefined;
	const refs: string[] = [];
	runTargets(steps, refs);
	const platforms = launchPlatforms(launch);
	return {
		id,
		file,
		kind: launch === undefined ? "fragment" : "e2e",
		runs: refs.map((r) => resolve(dirname(file), r)),
		...(platforms ? { launchPlatforms: platforms } : {}),
	};
}

/** All flow files below `flowsDir` (skipping dot dirs and screenshot baselines), sorted by id. */
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

/** Platforms a flow runs on: config, else an `ios`/`android` token in its id, else its `launch` map, else both. */
export function flowPlatforms(flow: Flow, settings: FlowSettings): Platform[] {
	if (settings.platforms) return settings.platforms;
	const token = PLATFORM_TOKEN.exec(flow.id)?.[1];
	if (token === "ios" || token === "android") return [token];
	return flow.launchPlatforms ?? ["ios", "android"];
}
