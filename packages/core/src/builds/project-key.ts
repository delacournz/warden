import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type AsyncResult, ok } from "@warden/types/result";
import type { Exec } from "../exec";

/**
 * Canonical `host/owner/repo` for a git remote, so every spelling of the same repo agrees:
 * `git@github.com:o/r.git` ≡ `https://github.com/o/r` ≡ `ssh://git@github.com/o/r`.
 * Host and path are lower-cased (GitHub/GitLab paths are case-insensitive).
 */
export function normaliseRemote(url: string): string {
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

/**
 * `<normalised remote>:<project subpath>` — NOT the worktree path, so every worktree/branch of the
 * same app shares one cache. Without a remote, the shared git dir stands in for it; outside git, the
 * absolute root.
 */
export function projectKey(input: ProjectKeyInput): string {
	if (!input.toplevel) return `path:${resolve(input.root)}`;
	const rel = relative(input.toplevel, input.root);
	const sub =
		rel === "" ? "." : isAbsolute(rel) || rel.startsWith("..") ? resolve(input.root) : rel.split(sep).join("/");
	const base = input.remote ? normaliseRemote(input.remote) : `git:${resolve(input.commonDir ?? input.toplevel)}`;
	return `${base}:${sub}`;
}

/** Filesystem-safe, collision-free form of a project key (cache dir name). */
export function safeKey(key: string): string {
	const readable = key
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 10);
	return `${readable}-${digest}`;
}

async function git(exec: Exec, cwd: string, args: string[]): Promise<string | undefined> {
	const res = await exec(["git", ...args], { cwd });
	return res.exitCode === 0 ? res.stdout.trim() || undefined : undefined;
}

function realpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Impure (via `exec`): project key for `root` from git toplevel / common dir / origin remote. */
export async function readProjectKey(exec: Exec, dir: string): AsyncResult<string> {
	// git reports real paths; `/var` vs `/private/var` (macOS tmp) must not look like a different dir
	const root = realpath(dir);
	const top = await git(exec, root, ["rev-parse", "--show-toplevel"]);
	if (!top) return ok(projectKey({ root }));
	const toplevel = realpath(top);
	const common = await git(exec, root, ["rev-parse", "--git-common-dir"]);
	let remote = await git(exec, root, ["config", "--get", "remote.origin.url"]);
	if (!remote) {
		const first = (await git(exec, root, ["remote"]))?.split("\n")[0];
		if (first) remote = await git(exec, root, ["config", "--get", `remote.${first}.url`]);
	}
	return ok(
		projectKey({
			root,
			toplevel,
			...(common ? { commonDir: isAbsolute(common) ? common : resolve(root, common) } : {}),
			...(remote ? { remote } : {}),
		})
	);
}
