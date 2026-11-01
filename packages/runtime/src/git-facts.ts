import { isAbsolute, resolve } from "node:path";
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

type Cached = { facts: GitFacts | undefined; at: number };

export type GitFactsCacheOptions = { ttlMs?: number; now?: () => number };

export const DEFAULT_GIT_FACTS_TTL_MS = 5_000;

/**
 * Memo of `GitFacts` per cwd, with entries expiring after `ttlMs` so a long-lived process
 * (`warden serve`) sees a branch switch. Remembers "not a git checkout" too. Create one per command
 * and pass it down to share reads. There is no module-level instance: the caller (host) holds the cache.
 */
export class GitFactsCache {
	/** async reads in flight, so concurrent callers of one cwd share a spawn */
	readonly pending = new Map<string, Promise<GitFacts | undefined>>();
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly entries = new Map<string, Cached>();

	constructor(options: GitFactsCacheOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_GIT_FACTS_TTL_MS;
		this.now = options.now ?? Date.now;
	}

	fresh(cwd: string): { facts: GitFacts | undefined } | undefined {
		const hit = this.entries.get(cwd);
		return hit !== undefined && this.now() - hit.at < this.ttlMs ? { facts: hit.facts } : undefined;
	}

	store(cwd: string, facts: GitFacts | undefined): void {
		this.entries.set(cwd, { facts, at: this.now() });
	}

	/**
	 * Store what was read for `cwd`, and under the checkout's own toplevel too: the facts of a checkout are the same from
	 * its root as from any directory inside it, so a later read of the root (a config dir, a project root) is free.
	 */
	remember(cwd: string, facts: GitFacts | undefined): void {
		this.store(cwd, facts);
		if (facts !== undefined && facts.toplevel !== cwd) this.store(facts.toplevel, facts);
	}
}

export type GitFactsSyncOptions = { run?: GitSyncRun; cache: GitFactsCache };

/** Reads `GitFacts` through git, sync or async, sharing one probe script. */
export class GitFactsReader {
	/** Default sync runner: real `git` via `Bun.spawnSync`. */
	readonly spawnSync: GitSyncRun = (cwd, args) => {
		try {
			const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
			return { exitCode: out.exitCode, stdout: out.stdout.toString() };
		} catch {
			return { exitCode: 127, stdout: "" };
		}
	};

	/** Sync read for call sites that cannot await (`resolveOwner`). One git spawn per cwd per cache lifetime. */
	readSync(cwd: string, options: GitFactsSyncOptions): GitFacts | undefined {
		const { cache } = options;
		const hit = cache.fresh(cwd);
		if (hit) return hit.facts;
		const run = options.run ?? this.spawnSync;
		const script = this.probe(cwd);
		let step = script.next();
		while (!step.done) step = script.next(run(cwd, step.value));
		cache.remember(cwd, step.value);
		return step.value;
	}

	/** Async read through the injected `Exec`; concurrent reads of one cwd share a spawn. */
	async read(exec: Exec, cwd: string, cache: GitFactsCache): Promise<GitFacts | undefined> {
		const hit = cache.fresh(cwd);
		if (hit) return hit.facts;
		const inFlight = cache.pending.get(cwd);
		if (inFlight) return inFlight;
		const read = this.readAsync(exec, cwd).then((found) => {
			cache.remember(cwd, found);
			return found;
		});
		cache.pending.set(cwd, read);
		try {
			return await read;
		} finally {
			cache.pending.delete(cwd);
		}
	}

	private async readAsync(exec: Exec, cwd: string): Promise<GitFacts | undefined> {
		const script = this.probe(cwd);
		let step = script.next();
		while (!step.done) {
			const res = await exec(["git", ...step.value], { cwd });
			step = script.next({ exitCode: res.exitCode, stdout: res.stdout });
		}
		return step.value;
	}

	/** HEAD's full ref; `HEAD` itself when detached. */
	private branchOf(ref: string): string {
		if (ref === "HEAD") return "";
		return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
	}

	private lines(stdout: string): string[] {
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	}

	private facts(cwd: string, toplevel: string, commonDir: string, branch: string): GitFacts {
		return { toplevel, commonDir: isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir), branch };
	}

	/**
	 * The git questions as a script, so the sync and async readers run the same logic: yield the argv,
	 * get the `GitRun` back. One `rev-parse` answers all three in the common case. Before the first
	 * commit `HEAD` does not resolve and rev-parse exits non-zero, but it has already printed the first
	 * two answers — only the branch is then asked for again. Anything else odd falls back to one call each.
	 */
	private *probe(cwd: string): Generator<readonly string[], GitFacts | undefined, GitRun> {
		const all = yield ["rev-parse", "--show-toplevel", "--git-common-dir", "--symbolic-full-name", "HEAD"];
		const answers = this.lines(all.stdout);
		const [top, common, ref] = answers;
		if (all.exitCode === 0 && top !== undefined && common !== undefined && ref !== undefined) {
			return this.facts(cwd, top, common, this.branchOf(ref));
		}
		if (top === undefined) return undefined;
		if (common !== undefined) {
			const current = yield ["branch", "--show-current"];
			return this.facts(cwd, top, common, current.exitCode === 0 ? current.stdout.trim() : "");
		}
		const toplevel = yield ["rev-parse", "--show-toplevel"];
		const topOut = toplevel.exitCode === 0 ? toplevel.stdout.trim() : "";
		if (topOut === "") return undefined;
		const commonDir = yield ["rev-parse", "--git-common-dir"];
		const commonOut = commonDir.exitCode === 0 ? commonDir.stdout.trim() : "";
		if (commonOut === "") return undefined;
		const branch = yield ["branch", "--show-current"];
		return this.facts(cwd, topOut, commonOut, branch.exitCode === 0 ? branch.stdout.trim() : "");
	}
}

export const gitFactsReader = new GitFactsReader();
