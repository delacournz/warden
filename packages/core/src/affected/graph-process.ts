import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { type Exec, execError } from "../exec";
import type { Platform } from "../types";
import type { E2eSuiteConfig } from "./affected.schema";
import { openImportCache } from "./cache";
import { createImportGraph, type ImportGraph, routerLayouts } from "./graph";
import {
	type GraphDoc,
	type GraphRequest,
	importsOfDoc,
	parseGraphDoc,
	readSnapshot,
	snapshotKey,
	writeSnapshot,
} from "./graph-snapshot";

/** `Exec`'s exit code for a command that could not start (no such binary): nothing to warn about, there is just no worker. */
const CANNOT_RUN = 127;

/** A walk that runs longer than this is killed and redone in this process. */
const WORKER_TIMEOUT_MS = 120_000;

/** Where the walker runs as a script (next to this file; not on disk inside a compiled binary). */
const WORKER_FILE = join(import.meta.dir, "graph-worker.ts");

/** Every file a diff run may start a walk from: each flow's entries (that exist) and the router layouts above them. */
export function graphEntries(suite: E2eSuiteConfig, configDir: string, platform: Platform): string[] {
	const entries = [...new Set(Object.values(suite.flows).flatMap((flow) => flow.entries))]
		.map((entry) => join(configDir, entry))
		.filter((entry) => existsSync(entry));
	const root = suite.routerRoot ? join(configDir, suite.routerRoot) : undefined;
	const layouts = root ? entries.flatMap((entry) => routerLayouts(entry, root, platform)) : [];
	return [...new Set([...entries, ...layouts])];
}

/** The `bun` that runs the walker: this process when it is bun, else the one on PATH. */
export function defaultBun(): string | undefined {
	return basename(process.execPath).startsWith("bun") ? process.execPath : (Bun.which("bun") ?? undefined);
}

export type LoadGraphOptions = {
	exec: Exec;
	platform: Platform;
	repoRoot: string;
	fallbackTsconfig?: string;
	/** where walks start (`graphEntries`); `imports` knows only the files reachable from these */
	entries: readonly string[];
	/** the per-file specifier cache, read and updated by whichever process walks */
	importCachePath?: string;
	/** snapshots of finished walks live here (`$WARDEN_HOME/affected`); without it nothing is kept */
	cacheDir?: string;
	/** runs the walker; `null`: none (walk in this process). Default: `defaultBun()` */
	bun?: string | null;
	/** the walker script; default: `graph-worker.ts` next to this file */
	worker?: string;
};

/** How the graph was had: a snapshot of an earlier walk, a walker process, or a walk in this process (`warning` says why a walker could not be used). */
export type LoadedGraph = { graph: ImportGraph; via: "snapshot" | "process" | "in-process"; warning?: string };

const fromTable = (doc: GraphDoc, via: "snapshot" | "process"): LoadedGraph => ({
	graph: { imports: importsOfDoc(doc), save: () => {} },
	via,
});

/** The walk done here, lazily (loads the TypeScript compiler into this process on the first import asked for). */
async function walkHere(opts: LoadGraphOptions, warning?: string): Promise<LoadedGraph> {
	const graph = await createImportGraph({
		platform: opts.platform,
		repoRoot: opts.repoRoot,
		...(opts.fallbackTsconfig !== undefined ? { fallbackTsconfig: opts.fallbackTsconfig } : {}),
		...(opts.importCachePath !== undefined ? { cache: openImportCache(opts.importCachePath) } : {}),
	});
	return { graph, via: "in-process", ...(warning !== undefined ? { warning } : {}) };
}

/** Run the walker script under `bun`: its table, or why there is none (`warning` unset: it could not even start). */
async function runWorker(
	opts: LoadGraphOptions,
	cmd: string[]
): Promise<{ doc: GraphDoc; warning?: undefined } | { doc?: undefined; warning?: string }> {
	const res = await opts.exec(cmd, { cwd: opts.repoRoot, timeoutMs: WORKER_TIMEOUT_MS });
	const doc = res.exitCode === 0 ? parseGraphDoc(res.stdout) : undefined;
	if (doc) return { doc };
	if (res.exitCode === CANNOT_RUN) return {};
	const why = res.exitCode === 0 ? "printed no import graph" : execError(cmd.slice(0, 2), res);
	return { warning: `import graph worker failed (${why}); built the graph in-process` };
}

/**
 * The import graph of one platform for the entries, without loading the TypeScript compiler here:
 * 1. a snapshot keyed by HEAD + the dirty state (`snapshotKey`) answers with no walk at all;
 * 2. else a `bun` process runs the walker and prints the table, which is then snapshotted;
 * 3. else (no bun or no script on disk, as in a compiled binary, or the walker failed) the walk
 *    is done here, lazily, as before.
 * A graph from 1 or 2 knows the imports of the files reachable from `entries` and nothing else.
 */
export async function loadImportGraph(opts: LoadGraphOptions): Promise<LoadedGraph> {
	const bun = opts.bun === undefined ? defaultBun() : (opts.bun ?? undefined);
	const worker = opts.worker ?? WORKER_FILE;
	if (bun === undefined || !existsSync(worker)) return walkHere(opts);

	const request: GraphRequest = {
		platform: opts.platform,
		repoRoot: opts.repoRoot,
		...(opts.fallbackTsconfig !== undefined ? { fallbackTsconfig: opts.fallbackTsconfig } : {}),
		entries: [...opts.entries],
		...(opts.importCachePath !== undefined ? { importCachePath: opts.importCachePath } : {}),
	};
	const { cacheDir } = opts;
	const key =
		cacheDir === undefined ? undefined : await snapshotKey(opts.exec, request, cacheDir).catch(() => undefined);
	const known = key === undefined || cacheDir === undefined ? undefined : readSnapshot(cacheDir, key);
	if (known) return fromTable(known, "snapshot");

	const built = await runWorker(opts, [bun, worker, JSON.stringify(request)]);
	if (!built.doc) return walkHere(opts, built.warning);
	if (key !== undefined && cacheDir !== undefined) writeSnapshot(cacheDir, key, built.doc);
	return fromTable(built.doc, "process");
}
