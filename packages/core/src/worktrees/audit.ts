import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { formatDuration } from "../duration";
import type { Exec, ExecResult } from "../exec";
import { type GitFactsCache, readGitFacts } from "../git-facts";
import { isLeaseAlive, type PidAlive } from "../liveness";
import type { Lease } from "../types";

export const WORKTREE_STATES = ["merged", "review", "unmerged", "active", "in-use", "locked", "stale-ref"] as const;
export type WorktreeStateName = (typeof WORKTREE_STATES)[number];

/** What every audited worktree carries. The main checkout is never one. */
export type WorktreeBase = {
	path: string;
	/** absolute common git dir, shared by every worktree of the repo */
	repo: string;
	/** the repo's main checkout: where git commands for this worktree run */
	mainPath: string;
	/** `""` on a detached HEAD */
	branch: string;
	head: string;
	/** `du -sk` bytes, when sized */
	bytes?: number;
	/** why it is in this state: `PR #12 merged`, `2 commits not on any remote` */
	evidence: string;
};

/**
 * One worktree and what warden may do with it. Only `merged` (clean, branch merged) is removed; `stale-ref`
 * (dir gone) is pruned. Everything else is report-only.
 */
export type WorktreeState = { [S in WorktreeStateName]: WorktreeBase & { state: S } }[WorktreeStateName];

/** One `git worktree list --porcelain` record. */
export type ParsedWorktree = {
	path: string;
	head: string;
	branch: string;
	detached: boolean;
	bare: boolean;
	/** `undefined` = not locked, `""` = locked without a reason */
	locked: string | undefined;
	prunable: boolean;
};

export type MapBounded = <T, R>(items: readonly T[], fn: (item: T) => Promise<R>) => Promise<R[]>;

export type WorktreeDeps = {
	exec: Exec;
	now: number;
	pidAlive: PidAlive;
	/** every lease in the store: their owners' cwds name the repos worth looking at and the worktrees in use */
	leases: readonly Lease[];
	cwd: string;
	git: GitFactsCache;
	/** did a file under `path` change within `withinMs`? default `findRecentChange` */
	recentChange?: (path: string, withinMs: number) => Promise<boolean>;
	/** delete lease rows by id; unset = leases are left alone */
	deleteLeases?: (ids: readonly string[]) => number;
	/** bounded fan-out over worktrees; default sequential */
	map?: MapBounded;
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
	listDirs?: (path: string) => string[];
};

export type WorktreeAuditOpts = {
	/** extra repo dirs (a checkout, or a folder of checkouts) beside the cwd and lease owners */
	roots: readonly string[];
	/** files changed within this are `active`; 0 turns the check off */
	idleMs: number;
	/** `git fetch --quiet` each repo before the merge checks */
	fetch: boolean;
};

export type WorktreeAudit = {
	entries: WorktreeState[];
	/** common git dirs audited */
	repos: string[];
	notes: string[];
};

const FETCH_TIMEOUT_MS = 60_000;

function git(deps: WorktreeDeps, cwd: string, args: readonly string[], timeoutMs?: number): Promise<ExecResult> {
	return deps.exec(["git", ...args], { cwd, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
}

const FIELDS: Record<string, (wt: ParsedWorktree, value: string) => void> = {
	HEAD: (wt, v) => {
		wt.head = v;
	},
	branch: (wt, v) => {
		wt.branch = v.replace(/^refs\/heads\//, "");
	},
	detached: (wt) => {
		wt.detached = true;
	},
	bare: (wt) => {
		wt.bare = true;
	},
	locked: (wt, v) => {
		wt.locked = v;
	},
	prunable: (wt) => {
		wt.prunable = true;
	},
};

/** `git worktree list --porcelain` → records; the first is the main checkout. */
export function parseWorktreeList(stdout: string): ParsedWorktree[] {
	const out: ParsedWorktree[] = [];
	for (const line of stdout.split("\n")) {
		const space = line.indexOf(" ");
		const key = space === -1 ? line : line.slice(0, space);
		const value = space === -1 ? "" : line.slice(space + 1);
		const last = out[out.length - 1];
		if (key === "worktree") {
			out.push({ path: value, head: "", branch: "", detached: false, bare: false, locked: undefined, prunable: false });
		} else if (last) {
			FIELDS[key]?.(last, value);
		}
	}
	return out;
}

/** `path` is `root` or lies under it. */
function inside(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function safeRealpath(deps: WorktreeDeps, path: string): string {
	try {
		return (deps.realpath ?? realpathSync)(path);
	} catch {
		return path;
	}
}

/** The spellings of `path` a cwd may use (a symlinked tmp or home resolves differently). */
function spellings(deps: WorktreeDeps, path: string): string[] {
	const real = safeRealpath(deps, path);
	return real === path ? [path] : [path, real];
}

const holds = (roots: readonly string[], path: string): boolean => roots.some((root) => inside(root, path));

/** Where a lease's owner works from, when it says. */
function leaseCwd(lease: Lease): string | undefined {
	return lease.owner.kind === "ci" ? undefined : lease.owner.cwd;
}

/** Leases whose owner works from inside `path`. */
function leasesIn(deps: WorktreeDeps, path: string): Lease[] {
	const roots = spellings(deps, path);
	return deps.leases.filter((l) => {
		const cwd = leaseCwd(l);
		return cwd !== undefined && (holds(roots, cwd) || holds(roots, safeRealpath(deps, cwd)));
	});
}

/**
 * Did a file under `path` change within `withinMs`? node_modules and .git are skipped. A `find` that cannot
 * run is "yes": a tree warden cannot inspect is not idle.
 */
export async function findRecentChange(exec: Exec, path: string, withinMs: number): Promise<boolean> {
	const minutes = Math.max(1, Math.ceil(withinMs / 60_000));
	const cmd = [
		"find",
		path,
		"(",
		"-name",
		"node_modules",
		"-o",
		"-name",
		".git",
		")",
		"-prune",
		"-o",
		"-type",
		"f",
		"-mmin",
		`-${minutes}`,
		"-print",
		"-quit",
	];
	const res = await exec(cmd);
	if (res.stdout.trim() !== "") return true;
	return res.exitCode !== 0;
}

/** Working directories of every process (`lsof -d cwd -Fn`); `undefined` = cannot inspect. */
async function processCwds(deps: WorktreeDeps): Promise<string[] | undefined> {
	const res = await deps.exec(["lsof", "-d", "cwd", "-Fn"]);
	if (res.exitCode !== 0 && res.stdout.trim() === "") return undefined;
	return res.stdout
		.split("\n")
		.filter((l) => l.startsWith("n/"))
		.map((l) => l.slice(1));
}

type Verdict = { state: WorktreeStateName; evidence: string };

type RepoContext = {
	deps: WorktreeDeps;
	opts: WorktreeAuditOpts;
	repo: string;
	mainPath: string;
	/** refs a branch counts as merged into, with how to say so */
	targets: Array<{ ref: string; label: string }>;
	/** all process cwds, or `undefined` when they could not be read */
	cwds: string[] | undefined;
};

/** The ref(s) merged branches land in: origin's default branch, else the main checkout's HEAD. */
async function mergeTargets(deps: WorktreeDeps, mainPath: string, mainHead: string): Promise<RepoContext["targets"]> {
	const sym = await git(deps, mainPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	const candidates = sym.exitCode === 0 ? [sym.stdout.trim()] : ["origin/main", "origin/master", "origin/develop"];
	for (const ref of candidates) {
		const ok = await git(deps, mainPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		if (ok.exitCode === 0) return [{ ref, label: ref }];
	}
	return mainHead === "" ? [] : [{ ref: mainHead, label: "the main checkout's HEAD" }];
}

async function mergedByAncestry(ctx: RepoContext, wt: ParsedWorktree): Promise<string | undefined> {
	for (const target of ctx.targets) {
		const res = await git(ctx.deps, wt.path, ["merge-base", "--is-ancestor", wt.head, target.ref]);
		if (res.exitCode === 0) return `merged into ${target.label}`;
	}
	return undefined;
}

type PrRow = { number?: number; headRefOid?: string };

function parsePrs(stdout: string): PrRow[] {
	try {
		const rows: unknown = JSON.parse(stdout);
		return Array.isArray(rows) ? (rows as PrRow[]) : [];
	} catch {
		return [];
	}
}

/** A merged PR from this branch whose head is the commit checked out here (a reused branch name proves nothing). */
async function mergedByPr(ctx: RepoContext, wt: ParsedWorktree): Promise<string | undefined> {
	if (wt.branch === "") return undefined;
	const cmd = ["gh", "pr", "list", "--head", wt.branch, "--state", "merged", "--json", "number,headRefOid"];
	const res = await ctx.deps.exec(cmd, { cwd: wt.path, timeoutMs: FETCH_TIMEOUT_MS });
	if (res.exitCode !== 0) return undefined;
	const hit = parsePrs(res.stdout).find((pr) => pr.headRefOid === wt.head && pr.number !== undefined);
	return hit ? `PR #${hit.number} merged` : undefined;
}

async function unpushedCommits(ctx: RepoContext, wt: ParsedWorktree): Promise<number> {
	const res = await git(ctx.deps, wt.path, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
	const n = Number(res.stdout.trim());
	return res.exitCode === 0 && Number.isInteger(n) ? n : Number.POSITIVE_INFINITY;
}

/** Why this worktree must not be touched right now, if something is using it. */
function inUse(ctx: RepoContext, wt: ParsedWorktree): Verdict | undefined {
	if (ctx.cwds === undefined) return { state: "in-use", evidence: "cannot inspect running processes (lsof)" };
	const roots = spellings(ctx.deps, wt.path);
	if (ctx.cwds.some((cwd) => holds(roots, cwd))) return { state: "in-use", evidence: "a process has its cwd inside" };
	const live = leasesIn(ctx.deps, wt.path).find((l) => isLeaseAlive(l, ctx.deps.now, ctx.deps.pidAlive));
	return live ? { state: "in-use", evidence: `live warden lease ${live.id}` } : undefined;
}

/** Uncommitted changes (untracked included) are the first thing that makes a tree review-only. */
async function dirtyVerdict(ctx: RepoContext, wt: ParsedWorktree): Promise<Verdict | undefined> {
	const status = await git(ctx.deps, wt.path, ["status", "--porcelain"]);
	if (status.exitCode !== 0) return { state: "review", evidence: "cannot read git status" };
	return status.stdout.trim() === "" ? undefined : { state: "review", evidence: "uncommitted changes" };
}

/** Merged evidence, else the unpushed-commit / unmerged verdict. */
async function afterActivity(ctx: RepoContext, wt: ParsedWorktree): Promise<Verdict> {
	const merged = (await mergedByAncestry(ctx, wt)) ?? (await mergedByPr(ctx, wt));
	if (merged) return { state: "merged", evidence: merged };
	const unpushed = await unpushedCommits(ctx, wt);
	if (unpushed === 0) return { state: "unmerged", evidence: "pushed, no merge found" };
	const evidence = Number.isFinite(unpushed)
		? `${unpushed} ${unpushed === 1 ? "commit" : "commits"} not on any remote`
		: "cannot tell which commits are on a remote";
	return { state: "review", evidence };
}

/** Facts that need no git: a missing dir, a lock, a process or lease inside. */
function staticVerdict(ctx: RepoContext, wt: ParsedWorktree): Verdict | undefined {
	const exists = ctx.deps.exists ?? existsSync;
	if (wt.prunable || !exists(wt.path)) return { state: "stale-ref", evidence: "directory is gone" };
	if (wt.locked !== undefined) return { state: "locked", evidence: wt.locked === "" ? "locked" : wt.locked };
	return inUse(ctx, wt);
}

async function activeVerdict(ctx: RepoContext, wt: ParsedWorktree): Promise<Verdict | undefined> {
	const { idleMs } = ctx.opts;
	if (idleMs <= 0) return undefined;
	const recent = ctx.deps.recentChange ?? ((path, ms) => findRecentChange(ctx.deps.exec, path, ms));
	return (await recent(wt.path, idleMs))
		? { state: "active", evidence: `files changed within ${formatDuration(idleMs)}` }
		: undefined;
}

async function classify(ctx: RepoContext, wt: ParsedWorktree): Promise<Verdict> {
	return (
		staticVerdict(ctx, wt) ??
		(await dirtyVerdict(ctx, wt)) ??
		(await activeVerdict(ctx, wt)) ??
		(await afterActivity(ctx, wt))
	);
}

const sequential: MapBounded = async (items, fn) => {
	const out: Awaited<ReturnType<typeof fn>>[] = [];
	for (const item of items) out.push(await fn(item));
	return out;
};

async function auditRepo(
	deps: WorktreeDeps,
	opts: WorktreeAuditOpts,
	repo: string,
	toplevel: string,
	cwds: string[] | undefined,
	notes: string[]
): Promise<WorktreeState[]> {
	const listed = await git(deps, toplevel, ["worktree", "list", "--porcelain"]);
	if (listed.exitCode !== 0) {
		notes.push(`${repo}: cannot list worktrees`);
		return [];
	}
	const [main, ...linked] = parseWorktreeList(listed.stdout);
	if (!main || linked.length === 0) return [];
	if (opts.fetch) {
		const fetched = await git(deps, main.path, ["fetch", "--quiet"], FETCH_TIMEOUT_MS);
		if (fetched.exitCode !== 0) notes.push(`${repo}: git fetch failed, merge checks use what is already local`);
	}
	const targets = await mergeTargets(deps, main.path, main.head);
	const ctx: RepoContext = { deps, opts, repo, mainPath: main.path, targets, cwds };
	const map = deps.map ?? sequential;
	return map(
		linked.filter((wt) => !wt.bare),
		async (wt): Promise<WorktreeState> => {
			const verdict = await classify(ctx, wt);
			return { ...verdict, path: wt.path, repo, mainPath: main.path, branch: wt.branch, head: wt.head };
		}
	);
}

/** Common dir of the repo `dir` belongs to, with a checkout to run git in; a non-repo `dir` is scanned one level down. */
async function reposUnder(
	deps: WorktreeDeps,
	dir: string,
	scan: boolean
): Promise<Array<{ commonDir: string; toplevel: string }>> {
	const facts = await readGitFacts(deps.exec, dir, deps.git);
	if (facts) return [{ commonDir: facts.commonDir, toplevel: facts.toplevel }];
	if (!scan) return [];
	const listDirs = deps.listDirs ?? defaultListDirs;
	const found = await Promise.all(listDirs(dir).map((child) => reposUnder(deps, child, false)));
	return found.flat();
}

function defaultListDirs(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith("."))
			.map((d) => join(path, d.name));
	} catch {
		return [];
	}
}

/** Repos to audit: the cwd's, every lease owner's, and each `--root`, one per common git dir. */
async function discoverRepos(deps: WorktreeDeps, roots: readonly string[]): Promise<Map<string, string>> {
	const owners = deps.leases.flatMap((l) => leaseCwd(l) ?? []);
	const dirs = [
		...[deps.cwd, ...owners].map((dir) => ({ dir, scan: false })),
		...roots.map((dir) => ({ dir, scan: true })),
	];
	const repos = new Map<string, string>();
	for (const { dir, scan } of dirs) {
		for (const { commonDir, toplevel } of await reposUnder(deps, dir, scan)) {
			if (!repos.has(commonDir)) repos.set(commonDir, toplevel);
		}
	}
	return repos;
}

/**
 * Every linked git worktree of the repos warden can see, classified. The main checkout is never an entry.
 * Read-only apart from `git fetch`.
 */
export async function auditWorktrees(deps: WorktreeDeps, opts: WorktreeAuditOpts): Promise<WorktreeAudit> {
	const repos = await discoverRepos(deps, opts.roots);
	const notes: string[] = [];
	const cwds = await processCwds(deps);
	const entries: WorktreeState[] = [];
	for (const [commonDir, toplevel] of repos) {
		entries.push(...(await auditRepo(deps, opts, commonDir, toplevel, cwds, notes)));
	}
	return { entries, repos: [...repos.keys()], notes };
}

export type WorktreeSummary = {
	total: number;
	byState: Record<WorktreeStateName, number>;
	/** `merged` entries `--apply` would remove */
	removable: number;
	removableBytes: number;
	/** sum over entries that were sized */
	bytes: number;
};

/** Counts and bytes per state, for `warden worktrees` totals and `warden disk`. */
export function summarizeWorktreeStates(entries: readonly WorktreeState[]): WorktreeSummary {
	const byState = Object.fromEntries(WORKTREE_STATES.map((s) => [s, 0])) as Record<WorktreeStateName, number>;
	let bytes = 0;
	let removableBytes = 0;
	for (const e of entries) {
		byState[e.state] += 1;
		bytes += e.bytes ?? 0;
		if (e.state === "merged") removableBytes += e.bytes ?? 0;
	}
	return { total: entries.length, byState, removable: byState.merged, removableBytes, bytes };
}

export type RemovalOutcome = "removed" | "pruned" | "skipped" | "refused" | "failed";

export type WorktreeRemoval = { entry: WorktreeState; outcome: RemovalOutcome; detail: string };

/** Leases that belonged to a removed worktree and are already dead: nothing else needs them. */
function releaseDeadLeases(deps: WorktreeDeps, path: string): void {
	if (!deps.deleteLeases) return;
	const dead = leasesIn(deps, path).filter((l) => !isLeaseAlive(l, deps.now, deps.pidAlive));
	if (dead.length > 0) deps.deleteLeases(dead.map((l) => l.id));
}

async function removeMerged(deps: WorktreeDeps, entry: WorktreeState): Promise<WorktreeRemoval> {
	const roots = spellings(deps, entry.path);
	if (holds(roots, deps.cwd) || holds(roots, safeRealpath(deps, deps.cwd))) {
		return { entry, outcome: "refused", detail: `you are inside it: cd ${entry.mainPath} and run again` };
	}
	const live = leasesIn(deps, entry.path).find((l) => isLeaseAlive(l, deps.now, deps.pidAlive));
	if (live) return { entry, outcome: "refused", detail: `live warden lease ${live.id}` };
	const res = await git(deps, entry.mainPath, ["worktree", "remove", entry.path]);
	if (res.exitCode !== 0) {
		const reason = (res.stderr || res.stdout).trim().split("\n").pop() ?? `exit ${res.exitCode}`;
		return { entry, outcome: "failed", detail: reason };
	}
	releaseDeadLeases(deps, entry.path);
	return { entry, outcome: "removed", detail: entry.evidence };
}

/** Prune a repo's stale refs once; later `stale-ref` entries of that repo share the answer. */
async function pruneStale(
	deps: WorktreeDeps,
	entry: WorktreeState,
	pruned: Map<string, Result<string>>
): Promise<WorktreeRemoval> {
	let outcome = pruned.get(entry.repo);
	if (!outcome) {
		const res = await git(deps, entry.mainPath, ["worktree", "prune"]);
		outcome = res.exitCode === 0 ? ok("pruned") : err(res.stderr.trim() || "prune failed");
		pruned.set(entry.repo, outcome);
	}
	if (!outcome.success) return { entry, outcome: "failed", detail: outcome.error };
	releaseDeadLeases(deps, entry.path);
	return { entry, outcome: "pruned", detail: "git worktree prune" };
}

/**
 * Remove the `merged` entries with plain `git worktree remove` (no `--force`: git refuses a tree that went
 * dirty since the audit) and prune each repo's `stale-ref` ones once. Never deletes a branch. Everything else
 * is `skipped`.
 */
export async function removeWorktrees(
	entries: readonly WorktreeState[],
	deps: WorktreeDeps
): Promise<WorktreeRemoval[]> {
	const pruned = new Map<string, Result<string>>();
	const results: WorktreeRemoval[] = [];
	for (const entry of entries) {
		if (entry.state === "merged") results.push(await removeMerged(deps, entry));
		else if (entry.state === "stale-ref") results.push(await pruneStale(deps, entry, pruned));
		else results.push({ entry, outcome: "skipped", detail: entry.state });
	}
	return results;
}
