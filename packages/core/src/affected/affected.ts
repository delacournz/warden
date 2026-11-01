import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_FILE, type ConfigSource, type FoundConfig, projectConfig } from "@delacour/warden-builds/config";
import { overlay as overlays } from "@delacour/warden-builds/overlay";
import { type E2eSuiteConfig, e2eSuiteSchema } from "@delacour/warden-config/affected.schema";
import { type ConditionsConfig, conditionsConfigs } from "@delacour/warden-config/conditions.config";
import type { Exec } from "@delacour/warden-runtime/exec";
import { GitFactsCache, gitFactsReader } from "@delacour/warden-runtime/git-facts";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, type ErrorResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { DEFAULT_E2E_COUNT, DEFAULT_SPECS_DIR, DEV_MENU_OFF_ARGS } from "./affected.defaults";
import { type ChangedFile, gitChanges } from "./git";
import { typescriptResolver } from "./graph";
import { graphLoader, type LoadedGraph } from "./graph-process";
import { type SelectInput, type Selection, specSelector } from "./select";
import { specScanner } from "./specs";

export type Suite = {
	name: string;
	config: E2eSuiteConfig;
	configDir: string;
	/** where the config came from (`overlay`: `configDir` is under `~/.warden`, specs resolve there) */
	source: ConfigSource;
	/** the checkout the suite is for: what `git diff` runs in (`configDir` itself unless the config is an overlay) */
	rootDir: string;
	/** where the runner / serve / setup run: the suite's `project` root, else `configDir` */
	cwd: string;
	/** root of `project` (what `app` installs) */
	projectRoot?: string;
	/** the default suite of an app that configures none: every spec runs, no git diff */
	implicit?: true;
	/** the suite's `headless`, else the top-level one (undefined: neither sets it) */
	headless?: boolean;
	/** the suite's `slim`, else the top-level one (undefined: neither sets it) */
	slim?: NonNullable<E2eSuiteConfig["slim"]>;
	/** the suite's `biometrics`, else the top-level one (undefined: neither sets it) */
	biometrics?: boolean;
	/** the suite's perf budgets over the top-level ones, per key (undefined: none set) */
	perfBudgets?: NonNullable<NonNullable<E2eSuiteConfig["perf"]>["budgets"]>;
	/** the suite's device conditions over the top-level ones, per area (undefined: none set) */
	conditions?: ConditionsConfig;
};

/** Why `findSuite` found no suite: `several_suites` is the one callers act on (name one), the rest are reported as is. */
export type SuiteError = {
	code: "several_suites" | "no_suites" | "unknown_suite" | "no_config" | "config";
	message: string;
	/** the configured suite names, for `several_suites` / `unknown_suite` */
	suites?: string[];
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
	/** no diff at all: every spec, or exactly the named ones (see `SelectInput.only`) */
	only?: SelectInput["only"];
	/** where the analysed project's TypeScript compiler is, undefined: none. Default: `typescriptResolver.resolve` */
	typescript?: (repoRoot: string) => string | undefined;
	/** persist parsed imports under this dir (one file per config dir), e.g. `$WARDEN_HOME/affected` */
	cacheDir?: string;
	/** per-command memo of the git facts (default: a short-lived shared one) */
	git?: GitFactsCache;
	/** locates the `~/.warden` overlay (`WARDEN_HOME`) */
	env: Record<string, string | undefined>;
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

export class AffectedService {
	/**
	 * `e2e.<name>` from the nearest warden config (walking up to the git root); with no suite configured
	 * and none named, the default suite of the Expo app around `cwd`.
	 */
	async findSuite(
		exec: Exec,
		cwd: string,
		name: string | undefined,
		git: GitFactsCache | undefined,
		env: Record<string, string | undefined>
	): AsyncResult<Suite, SuiteError> {
		const stopAt = (await gitFactsReader.read(exec, cwd, git ?? new GitFactsCache()))?.toplevel;
		const overlay = await overlays.dirUnlessRepoConfig(exec, cwd, stopAt, env, git);
		const found = projectConfig.find(cwd, stopAt, env, overlay);
		if (!found.success) return this.suiteError("config", found.error);
		const suites = found.data?.config.e2e ?? {};
		const names = Object.keys(suites);
		if (names.length === 0 && name === undefined) {
			const implicit = this.defaultSuite(cwd, stopAt, found.data?.config.headless, overlay, found.data?.config.slim);
			return implicit.success ? implicit : this.suiteError("config", implicit.error);
		}
		if (!found.data) return this.suiteError("no_config", `no ${CONFIG_FILE} found from ${cwd}`);
		const pick = name ?? (names.length === 1 ? names[0] : undefined);
		if (pick === undefined) {
			return names.length === 0
				? this.suiteError("no_suites", `no e2e suites in ${CONFIG_FILE}`)
				: this.suiteError("several_suites", `several e2e suites — name one (${names.join(", ")})`, names);
		}
		const config = suites[pick];
		if (!config) {
			return this.suiteError(
				"unknown_suite",
				`no e2e suite "${pick}" in ${CONFIG_FILE} (${names.join(", ") || "none"})`,
				names
			);
		}
		return resultFactory.ok(this.toSuite(pick, config, found.data));
	}

	/** Changed files → the specs each platform must run (with reasons), per `e2e.<suite>`. */
	async compute(given: AffectedInput): AsyncResult<Affected> {
		const suite = await this.findSuite(given.exec, given.cwd, given.suite, given.git, given.env);
		if (!suite.success) return resultFactory.err(suite.error.message);
		// a suite nobody mapped has nothing to diff against: every spec runs
		const everything = suite.data.implicit && !given.files && !given.only;
		const input: AffectedInput = everything ? { ...given, only: { mode: "all" } } : given;
		const { config, configDir } = suite.data;
		const base = input.base ?? config.base;
		const changes = await this.loadChanges(input, suite.data, base);
		if (!changes.success) return changes;
		const scan = specScanner.scan(join(configDir, config.specsDir));
		const graphNeed = this.graphNeeded(input, suite.data, changes.data);
		if (!graphNeed.success) return graphNeed;
		const needsGraph = graphNeed.data;
		const importCachePath =
			input.cacheDir === undefined ? undefined : join(input.cacheDir, `${Bun.hash(configDir).toString(36)}.json`);
		const selections: Selection[] = [];
		const warnings = [...scan.warnings];
		for (const platform of this.platformsOf(input, suite.data)) {
			const picked = await this.selectForPlatform({
				input,
				suite: suite.data,
				platform,
				needsGraph,
				importCachePath,
				changes: changes.data,
				specs: scan.specs,
			});
			if (!picked.success) return picked;
			if (picked.data.warning !== undefined) warnings.push(picked.data.warning);
			selections.push(picked.data.selection);
		}
		return resultFactory.ok({
			suite: suite.data,
			...(this.usesGit(input) ? { base } : {}),
			changes: changes.data,
			selections,
			warnings,
		});
	}

	private suiteError(code: SuiteError["code"], message: string, suites?: string[]): ErrorResult<SuiteError> {
		return {
			success: false,
			error: { code, message, ...(suites ? { suites } : {}) },
		};
	}

	/**
	 * The suite of an Expo app that configures none: every `*.e2e.ts` spec under `e2e/`, one
	 * `@delacour/warden-e2e` spec process per device, against the dev client (the `dev` variant when the
	 * project has one) on a Metro warden owns.
	 */
	private defaultSuite(
		cwd: string,
		stopAt: string | undefined,
		headless: boolean | undefined,
		overlayDir: string | undefined,
		slim?: NonNullable<E2eSuiteConfig["slim"]>
	): Result<Suite> {
		const project = projectConfig.load({
			start: cwd,
			env: {},
			...(overlayDir ? { overlayDir } : {}),
			variant: "dev",
			variantOptional: true,
			...(stopAt ? { stopAt } : {}),
		});
		if (!project.success) return project;
		const { name, root, variant } = project.data;
		if (!existsSync(join(root, DEFAULT_SPECS_DIR)))
			return resultFactory.err(
				`no e2e suites in ${CONFIG_FILE} and no ${DEFAULT_SPECS_DIR}/ specs in ${root} — run \`warden init\` to scaffold them`
			);
		const config = e2eSuiteSchema.parse({
			specsDir: DEFAULT_SPECS_DIR,
			isolate: "device",
			platform: "ios",
			count: DEFAULT_E2E_COUNT,
			app: variant === undefined ? true : { variant },
			metro: { launchArgs: DEV_MENU_OFF_ARGS },
		});
		return resultFactory.ok({
			name,
			config,
			configDir: root,
			source: project.data.source,
			rootDir: root,
			cwd: root,
			projectRoot: root,
			implicit: true,
			...(headless !== undefined ? { headless } : {}),
			...(slim !== undefined ? { slim } : {}),
		});
	}

	/** The suite with its project root resolved and the top-level `headless` as its default. */
	private toSuite(name: string, config: E2eSuiteConfig, found: FoundConfig): Suite {
		const { dir, rootDir, source, config: top } = found;
		const project = top.projects?.find((p) => p.name === config.project);
		const projectRoot = project ? resolve(rootDir, project.root) : undefined;
		const headless = config.headless ?? top.headless;
		const slim = config.slim ?? top.slim;
		const biometrics = config.biometrics ?? top.biometrics;
		const budgets = { ...top.perf?.budgets, ...config.perf?.budgets };
		const conditions = conditionsConfigs.mergeConditionsConfig(top.conditions, config.conditions);
		return {
			name,
			config,
			configDir: dir,
			source,
			rootDir,
			cwd: projectRoot ?? rootDir,
			...(projectRoot ? { projectRoot } : {}),
			...(headless !== undefined ? { headless } : {}),
			...(slim !== undefined ? { slim } : {}),
			...(biometrics !== undefined ? { biometrics } : {}),
			...(Object.keys(budgets).length > 0 ? { perfBudgets: budgets } : {}),
			...(conditions !== undefined ? { conditions } : {}),
		};
	}

	/** Repo-root-relative changes → relative to the config dir; files outside it are dropped. */
	private rebase(files: readonly ChangedFile[], top: string, configDir: string): ChangedFile[] {
		const to = (path: string) => relative(configDir, join(top, path));
		const inside = (path: string) => !path.startsWith("..") && !isAbsolute(path);
		return files.flatMap((f) => {
			const path = to(f.path);
			const from = f.from === undefined ? undefined : to(f.from);
			if (!inside(path)) return [];
			return [{ ...f, path, ...(from !== undefined && inside(from) ? { from } : {}) }];
		});
	}

	private async loadChanges(input: AffectedInput, suite: Suite, base: string): AsyncResult<ChangedFile[]> {
		if (input.only) return resultFactory.ok([]);
		if (input.files) {
			return resultFactory.ok(
				input.files.map((f) => ({ path: relative(suite.rootDir, join(input.cwd, f)), status: "modified" as const }))
			);
		}
		const changed = await gitChanges.list(input.exec, suite.configDir, base, input.git);
		if (!changed.success) return changed;
		return resultFactory.ok(this.rebase(changed.data.files, changed.data.top, suite.configDir));
	}

	private platformsOf(input: AffectedInput, suite: Suite): Platform[] {
		if (input.platform) return [input.platform];
		return suite.config.platform ? [suite.config.platform] : ["ios", "android"];
	}

	/** The graph of one platform (undefined: not `needed`): a snapshot or a worker process when it can be, so the TypeScript compiler stays out of this process. */
	private async importGraphFor(
		needed: boolean,
		input: AffectedInput,
		{ config, configDir }: Suite,
		platform: Platform,
		importCachePath: string | undefined
	): AsyncResult<LoadedGraph | undefined> {
		if (!needed) return resultFactory.ok(undefined);
		return graphLoader.load({
			exec: input.exec,
			platform,
			repoRoot: configDir,
			entries: graphLoader.entries(config, configDir, platform),
			...(config.tsconfig ? { fallbackTsconfig: join(configDir, config.tsconfig) } : {}),
			...(importCachePath !== undefined ? { importCachePath } : {}),
			...(input.cacheDir !== undefined ? { cacheDir: input.cacheDir } : {}),
		});
	}

	/**
	 * Whether a run walks imports (some spec has entries and something changed); an error when it must but the project
	 * at `configDir` has no TypeScript compiler for the walk (`typescriptResolver.resolve`), or its package.json says it is too old.
	 */
	private graphNeeded(
		input: AffectedInput,
		{ config, configDir }: Suite,
		changes: readonly ChangedFile[]
	): Result<boolean> {
		if (!(Object.values(config.specs).some((f) => f.entries.length > 0) && changes.length > 0))
			return resultFactory.ok(false);
		const path = (input.typescript ?? ((root: string) => typescriptResolver.resolve(root)))(configDir);
		if (path === undefined) return resultFactory.err(typescriptResolver.missing(configDir));
		const problem = typescriptResolver.versionProblem(path);
		return problem === undefined ? resultFactory.ok(true) : resultFactory.err(problem);
	}

	/** false when `files` / `only` replace the git diff (so there is no base to report). */
	private usesGit(input: AffectedInput): boolean {
		return !input.files && !input.only;
	}

	/** The specs one platform must run, with the import graph's warning when it loaded with one. */
	private async selectForPlatform(o: {
		input: AffectedInput;
		suite: Suite;
		platform: Platform;
		needsGraph: boolean;
		importCachePath: string | undefined;
		changes: readonly ChangedFile[];
		specs: SelectInput["specs"];
	}): AsyncResult<{ selection: Selection; warning: string | undefined }> {
		const { input, suite, platform } = o;
		const graph = await this.importGraphFor(o.needsGraph, input, suite, platform, o.importCachePath);
		if (!graph.success) return graph;
		const loaded = graph.data;
		const selection = specSelector.select({
			suite: suite.config,
			configDir: suite.configDir,
			platform,
			changes: o.changes,
			specs: o.specs,
			...(loaded ? { imports: loaded.graph.imports } : {}),
			...(input.only ? { only: input.only } : {}),
		});
		loaded?.graph.save();
		return resultFactory.ok({ selection, warning: loaded?.warning });
	}
}

export const affectedService = new AffectedService();
