import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Exec } from "./exec";

/** What warden asks git about a directory: the checkout, the shared git dir and the branch. */
export type GitFacts = {
	/** `--show-toplevel` of the checkout (a worktree has its own) */
	toplevel: string;
	/** absolute `--git-common-dir`, shared by every worktree of the repo */
	commonDir: string;
	/** current branch; `""` on a detached HEAD, like `git branch --show-current` */
	branch: string;
};

/** One finished git call. */
export type GitRun = { exitCode: number; stdout: string };

/** Injectable synchronous git: runs `git <args>` in `cwd`. Never throws (a missing git or cwd is exit 127). */
export type GitSyncRun = (cwd: string, args: readonly string[]) => GitRun;

export const bunGitSync: GitSyncRun = (cwd, args) => {
	try {
		const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		return { exitCode: out.exitCode, stdout: out.stdout.toString() };
	} catch {
		return { exitCode: 127, stdout: "" };
	}
};

type Cached = { facts: GitFacts | undefined; at: number };

/**
 * Memo of `GitFacts` per cwd, with entries expiring after `ttlMs` so a long-lived process
 * (`warden serve`) sees a branch switch. Remembers "not a git checkout" too. Create one per command
 * and pass it down to share reads; callers that pass none use `sharedGitFacts`.
 */
export type GitFactsCache = {
	fresh(cwd: string): { facts: GitFacts | undefined } | undefined;
	store(cwd: string, facts: GitFacts | undefined): void;
	/** async reads in flight, so concurrent callers of one cwd share a spawn */
	pending: Map<string, Promise<GitFacts | undefined>>;
};

export type GitFactsCacheOptions = { ttlMs?: number; now?: () => number };

export const DEFAULT_GIT_FACTS_TTL_MS = 5_000;

export function createGitFactsCache(options: GitFactsCacheOptions = {}): GitFactsCache {
	const ttlMs = options.ttlMs ?? DEFAULT_GIT_FACTS_TTL_MS;
	const now = options.now ?? Date.now;
	const entries = new Map<string, Cached>();
	return {
		fresh(cwd) {
			const hit = entries.get(cwd);
			return hit !== undefined && now() - hit.at < ttlMs ? { facts: hit.facts } : undefined;
		},
		store(cwd, facts) {
			entries.set(cwd, { facts, at: now() });
		},
		pending: new Map(),
	};
}

/**
 * Store what was read for `cwd`, and under the checkout's own toplevel too: the facts of a checkout are the same from
 * its root as from any directory inside it, so a later read of the root (a config dir, a project root) is free.
 */
function remember(cache: GitFactsCache, cwd: string, facts: GitFacts | undefined): void {
	cache.store(cwd, facts);
	if (facts !== undefined && facts.toplevel !== cwd) cache.store(facts.toplevel, facts);
}

/** Cache for callers that were not given one: short-lived on purpose (see `DEFAULT_GIT_FACTS_TTL_MS`). */
export const sharedGitFacts: GitFactsCache = createGitFactsCache();

/** HEAD's full ref; `HEAD` itself when detached. */
function branchOf(ref: string): string {
	if (ref === "HEAD") return "";
	return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function lines(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

function facts(cwd: string, toplevel: string, commonDir: string, branch: string): GitFacts {
	return { toplevel, commonDir: isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir), branch };
}

/**
 * The git questions as a script, so the sync and async readers run the same logic: yield the argv,
 * get the `GitRun` back. One `rev-parse` answers all three in the common case. Before the first
 * commit `HEAD` does not resolve and rev-parse exits non-zero, but it has already printed the first
 * two answers — only the branch is then asked for again. Anything else odd falls back to one call each.
 */
function* probe(cwd: string): Generator<readonly string[], GitFacts | undefined, GitRun> {
	const all = yield ["rev-parse", "--show-toplevel", "--git-common-dir", "--symbolic-full-name", "HEAD"];
	const answers = lines(all.stdout);
	const [top, common, ref] = answers;
	if (all.exitCode === 0 && top !== undefined && common !== undefined && ref !== undefined) {
		return facts(cwd, top, common, branchOf(ref));
	}
	if (top === undefined) return undefined;
	if (common !== undefined) {
		const current = yield ["branch", "--show-current"];
		return facts(cwd, top, common, current.exitCode === 0 ? current.stdout.trim() : "");
	}
	const toplevel = yield ["rev-parse", "--show-toplevel"];
	const topOut = toplevel.exitCode === 0 ? toplevel.stdout.trim() : "";
	if (topOut === "") return undefined;
	const commonDir = yield ["rev-parse", "--git-common-dir"];
	const commonOut = commonDir.exitCode === 0 ? commonDir.stdout.trim() : "";
	if (commonOut === "") return undefined;
	const branch = yield ["branch", "--show-current"];
	return facts(cwd, topOut, commonOut, branch.exitCode === 0 ? branch.stdout.trim() : "");
}

/** Env that changes how git finds the repo: with any of them set, only git itself answers. */
const DISCOVERY_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

type Env = Record<string, string | undefined>;

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function real(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** `<dir>/.git`: absent (`null`), the git dir it is or points to, or `undefined` when it is neither. */
function gitDirAt(dir: string): string | null | undefined {
	const dotGit = join(dir, ".git");
	let isDir: boolean;
	try {
		isDir = statSync(dotGit).isDirectory();
	} catch {
		return null;
	}
	if (isDir) return dotGit;
	const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "")?.[1];
	return pointer === undefined ? undefined : resolve(dir, pointer);
}

/** The branch HEAD names, `""` when detached, `undefined` for a HEAD this reader does not know. */
function headBranch(head: string): string | undefined {
	const ref = /^ref:\s*(\S+)\s*$/.exec(head.trim())?.[1];
	if (ref !== undefined) return branchOf(ref);
	return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head.trim()) ? "" : undefined;
}

/** Facts of the checkout at `toplevel` whose git dir is `found`; `undefined` hands the question to git. */
function checkoutAt(toplevel: string, found: string, cwd: string): GitFacts | undefined {
	const gitDir = real(found);
	if (gitDir === undefined || cwd === gitDir || cwd.startsWith(gitDir + sep)) return undefined;
	const head = readText(join(gitDir, "HEAD"));
	const branch = head === undefined ? undefined : headBranch(head);
	if (branch === undefined) return undefined;
	const pointer = readText(join(gitDir, "commondir"))?.trim();
	const commonDir = pointer ? real(resolve(gitDir, pointer)) : gitDir;
	if (commonDir === undefined) return undefined;
	const config = readText(join(commonDir, "config")) ?? "";
	if (/^\s*(worktree\s*=|bare\s*=\s*true)/im.test(config) || existsSync(join(gitDir, "config.worktree")))
		return undefined;
	return { toplevel, commonDir, branch };
}

/**
 * Git facts read straight from the checkout's files (`.git`, `HEAD`, `commondir`), no spawn: ~0.1 ms against the
 * ~8 ms a `git rev-parse` costs every warden command. Answers only for a plain checkout or linked worktree, with the
 * same realpath'd toplevel and common dir git prints; `undefined` (not "no repo") whenever git should be asked:
 * no `.git` found, discovery env set, `core.worktree`, a bare repo, a cwd inside the git dir, an odd HEAD.
 */
export function readGitFactsFromDisk(cwd: string, env: Env = process.env): GitFacts | undefined {
	if (DISCOVERY_ENV.some((key) => env[key] !== undefined)) return undefined;
	const start = real(cwd);
	if (start === undefined) return undefined;
	for (let dir = start; ; dir = dirname(dir)) {
		const found = gitDirAt(dir);
		if (found === undefined) return undefined;
		if (found !== null) return checkoutAt(dir, found, start);
		if (dirname(dir) === dir) return undefined;
	}
}

export type GitFactsSyncOptions = {
	run?: GitSyncRun;
	cache?: GitFactsCache;
	/** read a plain checkout's files instead of spawning git (default true) */
	fromDisk?: boolean;
	/** for the git discovery env (`GIT_DIR`, …); default `process.env` */
	env?: Env;
};

/** Sync read for call sites that cannot await (`resolveOwner`). A plain checkout spawns nothing; else one git spawn per cwd per cache lifetime. */
export function readGitFactsSync(cwd: string, options: GitFactsSyncOptions = {}): GitFacts | undefined {
	const cache = options.cache ?? sharedGitFacts;
	const hit = cache.fresh(cwd);
	if (hit) return hit.facts;
	const disk = options.fromDisk === false ? undefined : readGitFactsFromDisk(cwd, options.env);
	if (disk !== undefined) {
		remember(cache, cwd, disk);
		return disk;
	}
	const run = options.run ?? bunGitSync;
	const script = probe(cwd);
	let step = script.next();
	while (!step.done) step = script.next(run(cwd, step.value));
	remember(cache, cwd, step.value);
	return step.value;
}

async function readAsync(exec: Exec, cwd: string): Promise<GitFacts | undefined> {
	const disk = readGitFactsFromDisk(cwd);
	if (disk !== undefined) return disk;
	const script = probe(cwd);
	let step = script.next();
	while (!step.done) {
		const res = await exec(["git", ...step.value], { cwd });
		step = script.next({ exitCode: res.exitCode, stdout: res.stdout });
	}
	return step.value;
}

/** Async read through the injected `Exec`; concurrent reads of one cwd share a spawn. */
export async function readGitFacts(
	exec: Exec,
	cwd: string,
	cache: GitFactsCache = sharedGitFacts
): Promise<GitFacts | undefined> {
	const hit = cache.fresh(cwd);
	if (hit) return hit.facts;
	const inFlight = cache.pending.get(cwd);
	if (inFlight) return inFlight;
	const read = readAsync(exec, cwd).then((found) => {
		remember(cache, cwd, found);
		return found;
	});
	cache.pending.set(cwd, read);
	try {
		return await read;
	} finally {
		cache.pending.delete(cwd);
	}
}
