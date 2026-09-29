import { basename, dirname, isAbsolute, resolve } from "node:path";
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

function git(cwd: string, args: string[]): string | undefined {
	const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
	return out.exitCode === 0 ? out.stdout.toString().trim() : undefined;
}

/** Impure: read git toplevel / common dir / branch for `cwd`. */
export function readGitInfo(cwd: string): GitInfo | undefined {
	const toplevel = git(cwd, ["rev-parse", "--show-toplevel"]);
	const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
	if (!toplevel || !commonDir) return undefined;
	const branch = git(cwd, ["branch", "--show-current"]) ?? "";
	return parseGitInfo({ toplevel, commonDir: isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir), branch });
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
