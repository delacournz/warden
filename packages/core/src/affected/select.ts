import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Platform } from "../types";
import type { E2eSuiteConfig } from "./affected.schema";
import type { ChangedFile } from "./git";
import { chainTo, reachable, routerLayouts } from "./graph";
import { type Spec, type SpecSettings, specPlatforms, specSettings } from "./specs";

/** Why a spec was selected. Paths are relative to the config dir. */
export type Reason =
	| { kind: "run-all"; file: string; pattern: string }
	| { kind: "path"; file: string; pattern: string }
	/** `chain[0]` is the spec's entry, the last element the changed file */
	| { kind: "import"; file: string; chain: string[] }
	/** the spec file itself, or a fragment it `run:`s, changed */
	| { kind: "spec-file"; file: string }
	| { kind: "always"; pattern: string }
	| { kind: "unmapped" }
	/** `--all` */
	| { kind: "all" }
	/** `--specs`: named explicitly */
	| { kind: "requested"; pattern: string }
	/** `unmatched: "run-all"`: this counted change reached no spec */
	| { kind: "unmatched"; file: string };

export type SelectedSpec = { id: string; file: string; required: boolean; reasons: Reason[] };

export type Selection = {
	platform: Platform;
	selected: SelectedSpec[];
	/** runnable specs for this platform that nothing selected */
	skipped: string[];
	/** changed (non-ignored) files that selected no spec — gaps in the map */
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
	specs: readonly Spec[];
	/** resolved imports of a file (absolute paths); needed when some spec has entries */
	imports?: (file: string) => string[];
	/** skip the diff: every spec, or exactly the specs these ids / globs name (`include` / `exclude` still apply) */
	only?: { mode: "all" } | { mode: "specs"; patterns: readonly string[] };
};

const globMatch = (patterns: readonly string[], path: string) => patterns.find((p) => new Bun.Glob(p).match(path));

/** Spec files each spec runs, transitively (itself included). */
function specClosure(spec: Spec, byFile: ReadonlyMap<string, Spec>): Set<string> {
	const seen = new Set<string>([spec.file]);
	const queue = [...spec.runs];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		if (seen.has(file)) continue;
		seen.add(file);
		queue.push(...(byFile.get(file)?.runs ?? []));
	}
	return seen;
}

type Candidate = { spec: Spec; settings: SpecSettings };

/** What every spec's check shares: the changed paths and how to map config paths. */
type Scope = {
	input: SelectInput;
	paths: ReadonlySet<string>;
	abs: (path: string) => string;
	rel: (path: string) => string;
	byFile: ReadonlyMap<string, Spec>;
	warnings: string[];
};

/** Changed paths (both sides of a rename) that are in `scope` (when set) and aren't `ignore`d. */
function changedPaths(changes: readonly ChangedFile[], suite: E2eSuiteConfig): Set<string> {
	const paths = new Set<string>();
	for (const change of changes) {
		for (const path of [change.path, change.from]) {
			if (path === undefined || globMatch(suite.ignore, path) !== undefined) continue;
			if (suite.scope.length > 0 && globMatch(suite.scope, path) === undefined) continue;
			paths.add(path);
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

/** Changed files reachable from the spec's entries (+ router layouts above them). */
function importReasons(scope: Scope, { spec, settings }: Candidate): Reason[] {
	const { input, abs, rel } = scope;
	if (settings.entries.length === 0 || !input.imports) return [];
	const entries = settings.entries.map(abs).filter((entry) => {
		if (existsSync(entry)) return true;
		scope.warnings.push(`${spec.id}: entry ${rel(entry)} does not exist`);
		return false;
	});
	const root = input.suite.routerRoot ? abs(input.suite.routerRoot) : undefined;
	const layouts = root ? entries.flatMap((e) => routerLayouts(e, root, input.platform)) : [];
	const reach = reachable([...entries, ...layouts], input.imports, settings.maxDepth ?? input.suite.maxDepth);
	return [...scope.paths].flatMap((file): Reason[] =>
		reach.has(abs(file)) ? [{ kind: "import", file, chain: chainTo(reach, abs(file)).map(rel) }] : []
	);
}

function specFileReasons(scope: Scope, { spec }: Candidate): Reason[] {
	const closure = specClosure(spec, scope.byFile);
	return [...scope.paths].flatMap((file): Reason[] =>
		closure.has(scope.abs(file)) ? [{ kind: "spec-file", file }] : []
	);
}

function standingReasons(suite: E2eSuiteConfig, { spec, settings }: Candidate): Reason[] {
	const reasons: Reason[] = [];
	const always = globMatch(suite.always, spec.id);
	if (always !== undefined) reasons.push({ kind: "always", pattern: always });
	const unmapped = settings.entries.length === 0 && settings.paths.length === 0;
	if (unmapped && suite.unmapped === "run") reasons.push({ kind: "unmapped" });
	return reasons;
}

function pick(suite: E2eSuiteConfig, { spec, settings }: Candidate, reasons: Reason[]): SelectedSpec {
	return { id: spec.id, file: spec.file, required: settings.required ?? suite.required, reasons };
}

/** `unmatched: "run-all"`: every candidate not already selected joins, citing the unmatched files. */
function selectUnmatched(
	suite: E2eSuiteConfig,
	candidates: readonly Candidate[],
	selected: readonly SelectedSpec[],
	unreached: readonly string[]
): SelectedSpec[] {
	const reasons = unreached.map((file): Reason => ({ kind: "unmatched", file }));
	const have = new Set(selected.map((f) => f.id));
	const added = candidates.filter(({ spec }) => !have.has(spec.id)).map((c) => pick(suite, c, reasons));
	return [...selected, ...added].sort((a, b) => a.id.localeCompare(b.id));
}

/** `--all` / `--specs`: no diff, candidates in scan order. A pattern that names nothing is a warning. */
function selectOnly(input: SelectInput, warnings: string[], candidates: readonly Candidate[]): Selection {
	const { only, suite, platform } = input;
	const selected: SelectedSpec[] = [];
	const skipped: string[] = [];
	const patterns = only?.mode === "specs" ? only.patterns : [];
	for (const candidate of candidates) {
		const pattern = patterns.find((p) => p === candidate.spec.id || new Bun.Glob(p).match(candidate.spec.id));
		if (only?.mode === "all") selected.push(pick(suite, candidate, [{ kind: "all" }]));
		else if (pattern !== undefined) selected.push(pick(suite, candidate, [{ kind: "requested", pattern }]));
		else skipped.push(candidate.spec.id);
	}
	for (const p of patterns) {
		if (!candidates.some(({ spec }) => p === spec.id || new Bun.Glob(p).match(spec.id)))
			warnings.push(`--specs "${p}" matches no spec`);
	}
	return { platform, selected, skipped, unreached: [], warnings: [...new Set(warnings)] };
}

/** Every reason `candidate` is selected, in priority order (`runAll` hits suppress the import walk). */
function reasonsFor(scope: Scope, candidate: Candidate, runAll: readonly Reason[]): Reason[] {
	return [
		...runAll,
		...pathReasons(scope, candidate),
		...(runAll.length === 0 ? importReasons(scope, candidate) : []),
		...specFileReasons(scope, candidate),
		...standingReasons(scope.input.suite, candidate),
	];
}

/** Runnable e2e specs for the platform that `include` / `exclude` allow, with their settings. */
function candidatesFor({ suite, platform, specs }: SelectInput): Candidate[] {
	return specs
		.filter((f) => f.kind === "e2e")
		.map((spec) => ({ spec, settings: specSettings(spec.id, suite.specs) }))
		.filter(({ spec, settings }) => specPlatforms(spec, settings).includes(platform))
		.filter(({ spec }) => suite.include.length === 0 || globMatch(suite.include, spec.id) !== undefined)
		.filter(({ spec }) => globMatch(suite.exclude, spec.id) === undefined);
}

/**
 * Which e2e specs `changes` require on `platform`, each with its reasons. Priority: `runAll` globs
 * (select everything), a spec's `paths` globs, its import graph from `entries` (+ router layouts),
 * a changed spec / fragment file, then `always` and — with `unmapped: "run"` — specs with no mapping.
 */
export function selectSpecs(input: SelectInput): Selection {
	const { suite, configDir, platform } = input;
	const scope: Scope = {
		input,
		paths: changedPaths(input.changes, suite),
		abs: (path) => join(configDir, path),
		rel: (path) => relative(configDir, path),
		byFile: new Map(input.specs.map((f) => [f.file, f])),
		warnings: [],
	};
	const candidates = candidatesFor(input);
	if (input.only) return selectOnly(input, scope.warnings, candidates);
	const runAll = [...scope.paths].flatMap((file): Reason[] => {
		const pattern = globMatch(suite.runAll, file);
		return pattern === undefined ? [] : [{ kind: "run-all", file, pattern }];
	});

	const selected: SelectedSpec[] = [];
	const skipped: string[] = [];
	const reached = new Set<string>();
	for (const candidate of candidates) {
		const reasons = reasonsFor(scope, candidate, runAll);
		for (const reason of reasons) if ("file" in reason) reached.add(reason.file);
		const { spec } = candidate;
		if (reasons.length === 0) skipped.push(spec.id);
		else selected.push(pick(suite, candidate, reasons));
	}
	for (const reason of runAll) if ("file" in reason) reached.add(reason.file);
	const unreached = [...scope.paths].filter((p) => !reached.has(p)).sort();
	if (suite.unmatched === "run-all" && unreached.length > 0) {
		const all = selectUnmatched(suite, candidates, selected, unreached);
		return { platform, selected: all, skipped: [], unreached, warnings: [...new Set(scope.warnings)] };
	}
	return { platform, selected, skipped, unreached, warnings: [...new Set(scope.warnings)] };
}
