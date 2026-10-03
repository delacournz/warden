import { isAbsolute, join, relative, resolve } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { CONFIG_FILE, findWardenConfig } from "../builds/config";
import type { Exec } from "../exec";
import type { Platform } from "../types";
import type { E2eSuiteConfig } from "./affected.schema";
import { openImportCache } from "./cache";
import { scanFlows } from "./flows";
import { type ChangedFile, changedFiles } from "./git";
import { createImportGraph } from "./graph";
import { type Selection, selectFlows } from "./select";

export type Suite = {
	name: string;
	config: E2eSuiteConfig;
	configDir: string;
	/** where the runner / serve / setup run: the suite's `project` root, else `configDir` */
	cwd: string;
	/** root of `project` (what `app` installs) */
	projectRoot?: string;
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

/** `e2e.<name>` from the nearest `warden.config.json` (walking up to the git root). */
export async function findSuite(exec: Exec, cwd: string, name?: string): AsyncResult<Suite> {
	const top = await exec(["git", "rev-parse", "--show-toplevel"], { cwd });
	const stopAt = top.exitCode === 0 && top.stdout.trim() ? top.stdout.trim() : undefined;
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
	const { dir } = found.data;
	const project = found.data.config.projects?.find((p) => p.name === config.project);
	const projectRoot = project ? resolve(dir, project.root) : undefined;
	return ok({ name: pick, config, configDir: dir, cwd: projectRoot ?? dir, ...(projectRoot ? { projectRoot } : {}) });
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
	const cache = openImportCache(
		input.cacheDir === undefined ? undefined : join(input.cacheDir, `${Bun.hash(configDir).toString(36)}.json`)
	);
	const selections: Selection[] = [];
	for (const platform of platformsOf(input, suite.data)) {
		const graph = needsGraph
			? await createImportGraph({
					platform,
					repoRoot: configDir,
					cache,
					...(config.tsconfig ? { fallbackTsconfig: join(configDir, config.tsconfig) } : {}),
				})
			: undefined;
		selections.push(
			selectFlows({
				suite: config,
				configDir,
				platform,
				changes: changes.data,
				flows: scan.flows,
				...(graph ? { imports: graph.imports } : {}),
			})
		);
	}
	cache.save();
	return ok({
		suite: suite.data,
		...(input.files ? {} : { base }),
		changes: changes.data,
		selections,
		warnings: scan.warnings,
	});
}
