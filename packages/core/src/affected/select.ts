import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Platform } from "../types";
import type { E2eSuiteConfig } from "./affected.schema";
import { type Flow, type FlowSettings, flowPlatforms, flowSettings } from "./flows";
import type { ChangedFile } from "./git";
import { chainTo, reachable, routerLayouts } from "./graph";

/** Why a flow was selected. Paths are relative to the config dir. */
export type Reason =
	| { kind: "run-all"; file: string; pattern: string }
	| { kind: "path"; file: string; pattern: string }
	/** `chain[0]` is the flow's entry, the last element the changed file */
	| { kind: "import"; file: string; chain: string[] }
	/** the flow file itself, or a fragment it `run:`s, changed */
	| { kind: "flow-file"; file: string }
	| { kind: "always"; pattern: string }
	| { kind: "unmapped" };

export type SelectedFlow = { id: string; file: string; required: boolean; reasons: Reason[] };

export type Selection = {
	platform: Platform;
	selected: SelectedFlow[];
	/** runnable flows for this platform that nothing selected */
	skipped: string[];
	/** changed (non-ignored) files that selected no flow — gaps in the map */
	unreached: string[];
	warnings: string[];
};

export type SelectInput = {
	suite: E2eSuiteConfig;
	/** absolute; every config path and glob is relative to it */
	configDir: string;
	platform: Platform;
	/** relative to `configDir` */
	changes: readonly ChangedFile[];
	flows: readonly Flow[];
	/** resolved imports of a file (absolute paths); needed when some flow has entries */
	imports?: (file: string) => string[];
};

const globMatch = (patterns: readonly string[], path: string) => patterns.find((p) => new Bun.Glob(p).match(path));

/** Flow files each flow runs, transitively (itself included). */
function flowClosure(flow: Flow, byFile: ReadonlyMap<string, Flow>): Set<string> {
	const seen = new Set<string>([flow.file]);
	const queue = [...flow.runs];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		if (seen.has(file)) continue;
		seen.add(file);
		queue.push(...(byFile.get(file)?.runs ?? []));
	}
	return seen;
}

type Candidate = { flow: Flow; settings: FlowSettings };

/** What every flow's check shares: the changed paths and how to map config paths. */
type Scope = {
	input: SelectInput;
	paths: ReadonlySet<string>;
	abs: (path: string) => string;
	rel: (path: string) => string;
	byFile: ReadonlyMap<string, Flow>;
	warnings: string[];
};

/** Changed paths (both sides of a rename) that aren't `ignore`d. */
function changedPaths(changes: readonly ChangedFile[], ignore: readonly string[]): Set<string> {
	const paths = new Set<string>();
	for (const change of changes) {
		for (const path of [change.path, change.from]) {
			if (path !== undefined && globMatch(ignore, path) === undefined) paths.add(path);
		}
	}
	return paths;
}

function pathReasons(scope: Scope, { settings }: Candidate): Reason[] {
	return [...scope.paths].flatMap((file): Reason[] => {
		const pattern = globMatch(settings.paths, file);
		return pattern === undefined ? [] : [{ kind: "path", file, pattern }];
	});
}

/** Changed files reachable from the flow's entries (+ router layouts above them). */
function importReasons(scope: Scope, { flow, settings }: Candidate): Reason[] {
	const { input, abs, rel } = scope;
	if (settings.entries.length === 0 || !input.imports) return [];
	const entries = settings.entries.map(abs).filter((entry) => {
		if (existsSync(entry)) return true;
		scope.warnings.push(`${flow.id}: entry ${rel(entry)} does not exist`);
		return false;
	});
	const root = input.suite.routerRoot ? abs(input.suite.routerRoot) : undefined;
	const layouts = root ? entries.flatMap((e) => routerLayouts(e, root, input.platform)) : [];
	const reach = reachable([...entries, ...layouts], input.imports, settings.maxDepth ?? input.suite.maxDepth);
	return [...scope.paths].flatMap((file): Reason[] =>
		reach.has(abs(file)) ? [{ kind: "import", file, chain: chainTo(reach, abs(file)).map(rel) }] : []
	);
}

function flowFileReasons(scope: Scope, { flow }: Candidate): Reason[] {
	const closure = flowClosure(flow, scope.byFile);
	return [...scope.paths].flatMap((file): Reason[] =>
		closure.has(scope.abs(file)) ? [{ kind: "flow-file", file }] : []
	);
}

function standingReasons(suite: E2eSuiteConfig, { flow, settings }: Candidate): Reason[] {
	const reasons: Reason[] = [];
	const always = globMatch(suite.always, flow.id);
	if (always !== undefined) reasons.push({ kind: "always", pattern: always });
	const unmapped = settings.entries.length === 0 && settings.paths.length === 0;
	if (unmapped && suite.unmapped === "run") reasons.push({ kind: "unmapped" });
	return reasons;
}

/**
 * Which e2e flows `changes` require on `platform`, each with its reasons. Priority: `runAll` globs
 * (select everything), a flow's `paths` globs, its import graph from `entries` (+ router layouts),
 * a changed flow / fragment file, then `always` and — with `unmapped: "run"` — flows with no mapping.
 */
export function selectFlows(input: SelectInput): Selection {
	const { suite, configDir, platform } = input;
	const scope: Scope = {
		input,
		paths: changedPaths(input.changes, suite.ignore),
		abs: (path) => join(configDir, path),
		rel: (path) => relative(configDir, path),
		byFile: new Map(input.flows.map((f) => [f.file, f])),
		warnings: [],
	};
	const candidates: Candidate[] = input.flows
		.filter((f) => f.kind === "e2e")
		.map((flow) => ({ flow, settings: flowSettings(flow.id, suite.flows) }))
		.filter(({ flow, settings }) => flowPlatforms(flow, settings).includes(platform));
	const runAll = [...scope.paths].flatMap((file): Reason[] => {
		const pattern = globMatch(suite.runAll, file);
		return pattern === undefined ? [] : [{ kind: "run-all", file, pattern }];
	});

	const selected: SelectedFlow[] = [];
	const skipped: string[] = [];
	const reached = new Set<string>();
	for (const candidate of candidates) {
		const reasons = [
			...runAll,
			...pathReasons(scope, candidate),
			...(runAll.length === 0 ? importReasons(scope, candidate) : []),
			...flowFileReasons(scope, candidate),
			...standingReasons(suite, candidate),
		];
		for (const reason of reasons) if ("file" in reason) reached.add(reason.file);
		const { flow, settings } = candidate;
		if (reasons.length === 0) skipped.push(flow.id);
		else selected.push({ id: flow.id, file: flow.file, required: settings.required ?? suite.required, reasons });
	}
	for (const reason of runAll) if ("file" in reason) reached.add(reason.file);
	const unreached = [...scope.paths].filter((p) => !reached.has(p)).sort();
	return { platform, selected, skipped, unreached, warnings: [...new Set(scope.warnings)] };
}
