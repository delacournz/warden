import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Exec } from "@delacour/warden-runtime/exec";
import { GitFactsCache, gitFactsReader } from "@delacour/warden-runtime/git-facts";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";

export type ProjectKeyInput = {
	/** `remote.origin.url` (or first remote); absent for repos with no remote */
	remote?: string;
	/** git toplevel of the checkout (worktree) */
	toplevel?: string;
	/** absolute git common dir — shared by all worktrees; used when there is no remote */
	commonDir?: string;
	/** absolute project root */
	root: string;
};

/** Project identity shared by every worktree/branch of one app: the cache key and its filesystem-safe form. */
export class ProjectKeys {
	/**
	 * Canonical `host/owner/repo` for a git remote, so every spelling of the same repo agrees:
	 * `git@github.com:o/r.git` ≡ `https://github.com/o/r` ≡ `ssh://git@github.com/o/r`.
	 * Host and path are lower-cased (GitHub/GitLab paths are case-insensitive).
	 */
	normalise(url: string): string {
		let s = url.trim();
		let host: string;
		let path: string;
		const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s);
		if (scp?.[1] && scp[2] && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
			host = scp[1];
			path = scp[2];
		} else {
			try {
				const parsed = new URL(s);
				host = parsed.hostname;
				path = parsed.pathname;
			} catch {
				host = "local";
				path = s;
			}
		}
		s = `${host}/${path.replace(/^\/+/, "")}`;
		return s
			.replace(/\/+$/, "")
			.replace(/\.git$/, "")
			.replace(/\/+$/, "")
			.toLowerCase();
	}

	/**
	 * `<normalised remote>:<project subpath>` — NOT the worktree path, so every worktree/branch of the
	 * same app shares one cache. Without a remote, the shared git dir stands in for it; outside git, the
	 * absolute root.
	 */
	of(input: ProjectKeyInput): string {
		if (!input.toplevel) return `path:${resolve(input.root)}`;
		const rel = relative(input.toplevel, input.root);
		const sub =
			rel === "" ? "." : isAbsolute(rel) || rel.startsWith("..") ? resolve(input.root) : rel.split(sep).join("/");
		const base = input.remote ? this.normalise(input.remote) : `git:${resolve(input.commonDir ?? input.toplevel)}`;
		return `${base}:${sub}`;
	}

	/** Filesystem-safe, collision-free form of a project key (cache dir name). */
	safe(key: string): string {
		const readable = key
			.replace(/[^A-Za-z0-9._-]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 80);
		const digest = createHash("sha256").update(key).digest("hex").slice(0, 10);
		return `${readable}-${digest}`;
	}

	/**
	 * Impure (via `exec`): project key for `root` from git toplevel / common dir / origin remote. The
	 * checkout facts are one memoised `git rev-parse` (shared with the owner and project lookups through
	 * `cache`); only the remote costs a spawn of its own.
	 */
	async read(exec: Exec, dir: string, cache?: GitFactsCache): AsyncResult<string> {
		// git reports real paths; `/var` vs `/private/var` (macOS tmp) must not look like a different dir
		const root = this.realpath(dir);
		const facts = await gitFactsReader.read(exec, root, cache ?? new GitFactsCache());
		if (!facts) return resultFactory.ok(this.of({ root }));
		const toplevel = this.realpath(facts.toplevel);
		let remote = await this.git(exec, root, ["config", "--get", "remote.origin.url"]);
		if (!remote) {
			const first = (await this.git(exec, root, ["remote"]))?.split("\n")[0];
			if (first) remote = await this.git(exec, root, ["config", "--get", `remote.${first}.url`]);
		}
		return resultFactory.ok(this.of({ root, toplevel, commonDir: facts.commonDir, ...(remote ? { remote } : {}) }));
	}

	private async git(exec: Exec, cwd: string, args: string[]): Promise<string | undefined> {
		const res = await exec(["git", ...args], { cwd });
		return res.exitCode === 0 ? res.stdout.trim() || undefined : undefined;
	}

	private realpath(path: string): string {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	}
}

export const projectKeys = new ProjectKeys();
