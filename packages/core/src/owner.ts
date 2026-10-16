import { basename, dirname, isAbsolute, resolve } from "node:path";
import { type GitFactsSyncOptions, readGitFactsSync } from "./git-facts";
import type { Owner } from "./types";

export type GitInfo = { repo: string; worktree: string };

export type OwnerContext = {
	env: Record<string, string | undefined>;
	pid: number;
	ppid: number;
	cwd: string;
	/** Claude session id from hook stdin, when running as a hook */
	sessionId?: string;
	git?: GitInfo;
};

const SESSION_ENV = ["WARDEN_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"] as const;

function isCi(env: OwnerContext["env"]): boolean {
	const ci = env.CI?.toLowerCase();
	return ci === "true" || ci === "1" || env.GITHUB_ACTIONS === "true";
}

/**
 * Who is claiming. Order: hook session id → CI → session env (`WARDEN_SESSION_ID`,
 * `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`) → the user's parent process (the invoking shell).
 */
export function detectOwner(ctx: OwnerContext): Owner {
	const location = ctx.git ? { repo: ctx.git.repo, worktree: ctx.git.worktree } : {};
	if (ctx.sessionId) return { kind: "agent", sessionId: ctx.sessionId, cwd: ctx.cwd, ...location };
	if (isCi(ctx.env)) {
		return { kind: "ci", runId: ctx.env.GITHUB_RUN_ID ?? ctx.env.CI_PIPELINE_ID ?? ctx.env.BUILDKITE_BUILD_ID ?? "ci" };
	}
	for (const key of SESSION_ENV) {
		const sessionId = ctx.env[key];
		if (sessionId) return { kind: "agent", sessionId, cwd: ctx.cwd, ...location };
	}
	const tty = ctx.env.TTY ? { tty: ctx.env.TTY } : {};
	return { kind: "user", pid: ctx.ppid, ...tty, cwd: ctx.cwd, ...location };
}

/** repo = parent dir of the shared git dir; worktree = checkout dir name + `@branch`. */
export function parseGitInfo(raw: { toplevel: string; commonDir: string; branch: string }): GitInfo {
	const common = isAbsolute(raw.commonDir) ? raw.commonDir : resolve(raw.toplevel, raw.commonDir);
	const repo = basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
	const dir = basename(raw.toplevel);
	return { repo, worktree: raw.branch ? `${dir}@${raw.branch}` : dir };
}

/**
 * Impure: git toplevel / common dir / branch for `cwd` — one `git rev-parse`, memoised per cwd (see
 * `git-facts`). Pass `cache` to scope the memo to one command; the default is a short-lived shared one.
 */
export function readGitInfo(cwd: string, options: GitFactsSyncOptions = {}): GitInfo | undefined {
	const facts = readGitFactsSync(cwd, options);
	return facts ? parseGitInfo(facts) : undefined;
}

/** Impure convenience: owner for the current process. */
export function currentOwner(sessionId?: string): Owner {
	const cwd = process.cwd();
	const ctx: OwnerContext = { env: process.env, pid: process.pid, ppid: process.ppid, cwd };
	const gitInfo = readGitInfo(cwd);
	if (gitInfo) ctx.git = gitInfo;
	if (sessionId) ctx.sessionId = sessionId;
	return detectOwner(ctx);
}
