import { join } from "node:path";
import type { Exec } from "@delacour/warden-runtime/exec";
import { GitFactsCache, gitFactsReader } from "@delacour/warden-runtime/git-facts";
import { storeLocator } from "@delacour/warden-store/store";
import { projectConfig } from "./config";
import { projectKeys } from "./project-key";

/** Where the per-project overlay (warden config + e2e specs kept outside the repo) lives. Stateless; use the `overlay` singleton. */
export class Overlay {
	/** `<WARDEN_HOME>/projects/<key>/`: warden config + e2e specs kept outside the repo (private mode). */
	dir(env: Record<string, string | undefined>, projectKey: string): string {
		return join(storeLocator.wardenHome(env), "projects", projectKeys.safe(projectKey));
	}

	/**
	 * The overlay of the repo around `start`. Keyed on the git toplevel (`<remote>:.`, else the shared git
	 * dir), so every worktree and branch of one repo reads the same overlay; outside git, on `start`.
	 * `projectKey` already ignores the worktree path (remote, else `--git-common-dir`), so no extra
	 * derivation is needed for stability.
	 */
	async dirFor(
		exec: Exec,
		start: string,
		env: Record<string, string | undefined>,
		git?: GitFactsCache
	): Promise<string | undefined> {
		const toplevel = (await gitFactsReader.read(exec, start, git ?? new GitFactsCache()))?.toplevel;
		const key = await projectKeys.read(exec, toplevel ?? start, git);
		return key.success ? this.dir(env, key.data) : undefined;
	}

	/**
	 * `dirFor`, but only when the repo has no config of its own (it wins, so the overlay — and the
	 * git calls its key costs — are never needed). `stopAt` is the git toplevel the caller already read.
	 */
	async dirUnlessRepoConfig(
		exec: Exec,
		start: string,
		stopAt: string | undefined,
		env: Record<string, string | undefined>,
		git?: GitFactsCache
	): Promise<string | undefined> {
		return projectConfig.hasRepoConfig(start, stopAt) ? undefined : this.dirFor(exec, start, env, git);
	}
}

export const overlay = new Overlay();
