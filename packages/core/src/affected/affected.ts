import { isAbsolute, join, relative, resolve } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { CONFIG_FILE, findWardenConfig, type ParsedWardenConfig } from "../builds/config";
import type { Exec } from "../exec";
import { type GitFactsCache, readGitFacts } from "../git-facts";
import type { Platform } from "../types";
import type { E2eSuiteConfig } from "./affected.schema";
import { scanFlows } from "./flows";
import { type ChangedFile, changedFiles } from "./git";
import { graphEntries, type LoadedGraph, loadImportGraph } from "./graph-process";
import { type SelectInput, type Selection, selectFlows } from "./select";

export type Suite = {
	name: string;
	config: E2eSuiteConfig;
	configDir: string;
	/** where the runner / serve / setup run: the suite's `project` root, else `configDir` */
	cwd: string;
	/** root of `project` (what `app` installs) */
	projectRoot?: string;
	/** the suite's `headless`, else the top-level one (undefined: neither sets it) */
	headless?: boolean;
};

export type AffectedInput = {
	exec: Exec;
	cwd: string;
	/** `e2e.<name>`; optional when the config has exactly one suite */
	suite?: string;
	/** default: the suite's `base` */
	base?: string;
	/** default: the suite's `platform`, else both */
	platform?: Platform;
	/** use these (relative to cwd) instead of `git diff` */
	files?: readonly string[];
	/** no diff at all: every flow, or exactly the named ones (see `SelectInput.only`) */
	only?: SelectInput["only"];
	/** persist parsed imports under this dir (one file per config dir), e.g. `$WARDEN_HOME/affected` */
	cacheDir?: string;
};

export type Affected = {
	suite: Suite;
	/** undefined when `files` were given */
	base?: string;
	/** relative to the config dir */
	changes: ChangedFile[];
	selections: Selection[];
	warnings: string[];
};

/** `e2e.<name>` from the nearest warden config (walking up to the git root). */
export async function findSuite(exec: Exec, cwd: string, name?: string, git?: GitFactsCache): AsyncResult<Suite> {
	const stopAt = (await readGitFacts(exec, cwd, git))?.toplevel;
	const found = findWardenConfig(cwd, stopAt);
	if (!found.success) return found;
	if (!found.data) return err(`no ${CONFIG_FILE} found from ${cwd}`);
	const suites = found.data.config.e2e ?? {};
	const names = Object.keys(suites);
	const pick = name ?? (names.length === 1 ? names[0] : undefined);
	if (pick === undefined)
		return err(
			names.length === 0 ? `no e2e suites in ${CONFIG_FILE}` : `several e2e suites — name one (${names.join(", ")})`
		);
	const config = suites[pick];
	if (!config) return err(`no e2e suite "${pick}" in ${CONFIG_FILE} (${names.join(", ") || "none"})`);
	return ok(toSuite(pick, config, found.data.dir, found.data.config));
}

/** The suite with its project root resolved and the top-level `headless` as its default. */
function toSuite(name: string, config: E2eSuiteConfig, dir: string, top: ParsedWardenConfig): Suite {
	const project = top.projects?.find((p) => p.name === config.project);
	const projectRoot = project ? resolve(dir, project.root) : undefined;
	const headless = config.headless ?? top.headless;
	return {
		name,
		config,
		configDir: dir,
		cwd: projectRoot ?? dir,
		...(projectRoot ? { projectRoot } : {}),
		...(headless !== undefined ? { headless } : {}),
	};
}

/** Repo-root-relative changes → relative to the config dir; files outside it are dropped. */
function rebase(files: readonly ChangedFile[], top: string, configDir: string): ChangedFile[] {
	const to = (path: string) => relative(configDir, join(top, path));
	const inside = (path: string) => !path.startsWith("..") && !isAbsolute(path);
	return files.flatMap((f) => {
		const path = to(f.path);
		const from = f.from === undefined ? undefined : to(f.from);
		if (!inside(path)) return [];
		return [{ ...f, path, ...(from !== undefined && inside(from) ? { from } : {}) }];
	});
}

async function loadChanges(input: AffectedInput, suite: Suite, base: string): AsyncResult<ChangedFile[]> {
	if (input.only) return ok([]);
	if (input.files) {
		return ok(
			input.files.map((f) => ({ path: relative(suite.configDir, join(input.cwd, f)), status: "modified" as const }))
		);
	}
	const changed = await changedFiles(input.exec, suite.configDir, base);
	if (!changed.success) return changed;
	return ok(rebase(changed.data.files, changed.data.top, suite.configDir));
}

function platformsOf(input: AffectedInput, suite: Suite): Platform[] {
	if (input.platform) return [input.platform];
	return suite.config.platform ? [suite.config.platform] : ["ios", "android"];
}

/** The graph of one platform: a snapshot or a worker process when it can be, so the TypeScript compiler stays out of this process. */
function importGraphFor(
	input: AffectedInput,
	{ config, configDir }: Suite,
	platform: Platform,
	importCachePath: string | undefined
): Promise<LoadedGraph> {
	return loadImportGraph({
		exec: input.exec,
		platform,
		repoRoot: configDir,
		entries: graphEntries(config, configDir, platform),
		...(config.tsconfig ? { fallbackTsconfig: join(configDir, config.tsconfig) } : {}),
		...(importCachePath !== undefined ? { importCachePath } : {}),
		...(input.cacheDir !== undefined ? { cacheDir: input.cacheDir } : {}),
	});
}

/** false when `files` / `only` replace the git diff (so there is no base to report). */
const usesGit = (input: AffectedInput): boolean => !input.files && !input.only;

/** Changed files → the flows each platform must run (with reasons), per `e2e.<suite>`. */
export async function computeAffected(input: AffectedInput): AsyncResult<Affected> {
	const suite = await findSuite(input.exec, input.cwd, input.suite);
	if (!suite.success) return suite;
	const { config, configDir } = suite.data;
	const base = input.base ?? config.base;
	const changes = await loadChanges(input, suite.data, base);
	if (!changes.success) return changes;
	const scan = scanFlows(join(configDir, config.flowsDir));
	const needsGraph = Object.values(config.flows).some((f) => f.entries.length > 0) && changes.data.length > 0;
	const importCachePath =
		input.cacheDir === undefined ? undefined : join(input.cacheDir, `${Bun.hash(configDir).toString(36)}.json`);
	const selections: Selection[] = [];
	const warnings = [...scan.warnings];
	for (const platform of platformsOf(input, suite.data)) {
		const loaded = needsGraph ? await importGraphFor(input, suite.data, platform, importCachePath) : undefined;
		if (loaded?.warning !== undefined) warnings.push(loaded.warning);
		selections.push(
			selectFlows({
				suite: config,
				configDir,
				platform,
				changes: changes.data,
				flows: scan.flows,
				...(loaded ? { imports: loaded.graph.imports } : {}),
				...(input.only ? { only: input.only } : {}),
			})
		);
		loaded?.graph.save();
	}
	return ok({
		suite: suite.data,
		...(usesGit(input) ? { base } : {}),
		changes: changes.data,
		selections,
		warnings,
	});
}
