import { join } from "node:path";
import type { Exec } from "../exec";
import { type GitFactsCache, readGitFacts } from "../git-facts";
import { wardenHome } from "../store";
import { hasRepoConfig } from "./config";
import { readProjectKey, safeKey } from "./project-key";

/** `<WARDEN_HOME>/projects/<key>/`: warden config + e2e specs kept outside the repo (private mode). */
export function overlayDir(env: Record<string, string | undefined>, projectKey: string): string {
	return join(wardenHome(env), "projects", safeKey(projectKey));
}

/**
 * The overlay of the repo around `start`. Keyed on the git toplevel (`<remote>:.`, else the shared git
 * dir), so every worktree and branch of one repo reads the same overlay; outside git, on `start`.
 * `projectKey` already ignores the worktree path (remote, else `--git-common-dir`), so no extra
 * derivation is needed for stability.
 */
export async function overlayDirFor(
	exec: Exec,
	start: string,
	env: Record<string, string | undefined>,
	git?: GitFactsCache
): Promise<string | undefined> {
	const toplevel = (await readGitFacts(exec, start, git))?.toplevel;
	const key = await readProjectKey(exec, toplevel ?? start, git);
	return key.success ? overlayDir(env, key.data) : undefined;
}

/**
 * `overlayDirFor`, but only when the repo has no config of its own (it wins, so the overlay — and the
 * git calls its key costs — are never needed). `stopAt` is the git toplevel the caller already read.
 */
export async function overlayDirUnlessRepoConfig(
	exec: Exec,
	start: string,
	stopAt: string | undefined,
	env: Record<string, string | undefined>,
	git?: GitFactsCache
): Promise<string | undefined> {
	return hasRepoConfig(start, stopAt) ? undefined : overlayDirFor(exec, start, env, git);
}
