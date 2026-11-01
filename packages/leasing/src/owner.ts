import { basename, dirname, isAbsolute, resolve } from "node:path";
import { type GitFactsCache, type GitFactsSyncOptions, gitFactsReader } from "@delacour/warden-runtime/git-facts";
import type { Owner } from "@delacour/warden-store/types";

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

export class OwnerResolver {
	/**
	 * Who is claiming. Order: hook session id → CI → session env (`WARDEN_SESSION_ID`,
	 * `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`) → the user's parent process (the invoking shell).
	 */
	detect(ctx: OwnerContext): Owner {
		const location = ctx.git ? { repo: ctx.git.repo, worktree: ctx.git.worktree } : {};
		if (ctx.sessionId) return { kind: "agent", sessionId: ctx.sessionId, cwd: ctx.cwd, ...location };
		if (this.isCi(ctx.env)) {
			return {
				kind: "ci",
				runId: ctx.env.GITHUB_RUN_ID ?? ctx.env.CI_PIPELINE_ID ?? ctx.env.BUILDKITE_BUILD_ID ?? "ci",
			};
		}
		for (const key of SESSION_ENV) {
			const sessionId = ctx.env[key];
			if (sessionId) return { kind: "agent", sessionId, cwd: ctx.cwd, ...location };
		}
		const tty = ctx.env.TTY ? { tty: ctx.env.TTY } : {};
		return { kind: "user", pid: ctx.ppid, ...tty, cwd: ctx.cwd, ...location };
	}

	/** repo = parent dir of the shared git dir; worktree = checkout dir name + `@branch`. */
	parseGitInfo(raw: { toplevel: string; commonDir: string; branch: string }): GitInfo {
		const common = isAbsolute(raw.commonDir) ? raw.commonDir : resolve(raw.toplevel, raw.commonDir);
		const repo = basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
		const dir = basename(raw.toplevel);
		return { repo, worktree: raw.branch ? `${dir}@${raw.branch}` : dir };
	}

	/**
	 * Impure: git toplevel / common dir / branch for `cwd` — one `git rev-parse`, memoised per cwd (see
	 * `git-facts`). `cache` scopes the memo (one per command or host).
	 */
	readGitInfo(cwd: string, options: GitFactsSyncOptions): GitInfo | undefined {
		const facts = gitFactsReader.readSync(cwd, options);
		return facts ? this.parseGitInfo(facts) : undefined;
	}

	/** Impure convenience: owner for the current process. */
	current(env: Record<string, string | undefined>, facts: GitFactsCache, sessionId?: string): Owner {
		const cwd = process.cwd();
		const ctx: OwnerContext = { env, pid: process.pid, ppid: process.ppid, cwd };
		const gitInfo = this.readGitInfo(cwd, { cache: facts });
		if (gitInfo) ctx.git = gitInfo;
		if (sessionId) ctx.sessionId = sessionId;
		return this.detect(ctx);
	}

	/** Owner for this invocation: `sessionId` (`--session` / hook id) → CI → session env → the invoking shell (ppid). */
	resolve(host: { env: OwnerContext["env"]; cwd: string; git: GitFactsCache }, sessionId?: string): Owner {
		const ownerCtx: OwnerContext = { env: host.env, pid: process.pid, ppid: process.ppid, cwd: host.cwd };
		const gitInfo = this.readGitInfo(host.cwd, { cache: host.git });
		if (gitInfo) ownerCtx.git = gitInfo;
		if (sessionId) ownerCtx.sessionId = sessionId;
		return this.detect(ownerCtx);
	}

	/** Lookup-only owner for `--session S` (owner_key only uses the session id). */
	sessionOwner(sessionId: string, cwd = ""): Owner {
		return { kind: "agent", sessionId, cwd };
	}

	/** User leases live as long as their shell; agent / CI leases rely on heartbeat + ttl. */
	leasePidFor(owner: Owner): number | undefined {
		return owner.kind === "user" ? owner.pid : undefined;
	}

	private isCi(env: OwnerContext["env"]): boolean {
		const ci = env.CI?.toLowerCase();
		return ci === "true" || ci === "1" || env.GITHUB_ACTIONS === "true";
	}
}

export const ownerResolver = new OwnerResolver();
