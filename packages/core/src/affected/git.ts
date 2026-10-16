import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { type GitFactsCache, readGitFacts } from "../git-facts";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

/** A path (relative to the repo root) that differs from the merge-base; `from` = the old path of a rename/copy. */
export type ChangedFile = { path: string; status: ChangeStatus; from?: string };

const STATUS: Record<string, ChangeStatus> = {
	A: "added",
	M: "modified",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "type-changed",
};

/** `git diff --name-status -z` output → changed files (rename/copy records carry two paths). */
export function parseNameStatus(out: string): ChangedFile[] {
	const parts = out.split("\0").filter((p) => p.length > 0);
	const files: ChangedFile[] = [];
	for (let i = 0; i < parts.length; ) {
		const code = parts[i++]?.[0] ?? "M";
		const status = STATUS[code] ?? "modified";
		if (status === "renamed" || status === "copied") {
			const from = parts[i++] ?? "";
			files.push({ path: parts[i++] ?? "", status, from });
		} else {
			files.push({ path: parts[i++] ?? "", status });
		}
	}
	return files;
}

/**
 * Everything that differs from `merge-base(base, HEAD)`: commits on the branch, staged and unstaged
 * edits, and untracked (non-ignored) files. Paths are relative to `top`, the repo root, which comes from the git
 * facts (`git`, else the shared short-lived cache) so a caller that already asked for them does not spawn again.
 */
export async function changedFiles(
	exec: Exec,
	cwd: string,
	base: string,
	git?: GitFactsCache
): AsyncResult<{ top: string; mergeBase: string; files: ChangedFile[] }> {
	const run = async (args: string[]) => {
		const cmd = ["git", ...args];
		const res = await exec(cmd, { cwd });
		return res.exitCode === 0 ? ok(res.stdout) : err(execError(cmd, res));
	};
	const facts = await readGitFacts(exec, cwd, git);
	if (!facts) return err(`not a git checkout: ${cwd}`);
	const mergeBase = await run(["merge-base", base, "HEAD"]);
	if (!mergeBase.success) return err(`no merge-base with "${base}": ${mergeBase.error}`);
	const mb = mergeBase.data.trim();
	const diff = await run(["diff", "--name-status", "-M", "-z", mb, "--"]);
	if (!diff.success) return diff;
	const untracked = await run(["ls-files", "--others", "--exclude-standard", "-z"]);
	if (!untracked.success) return untracked;
	const files = parseNameStatus(diff.data);
	const seen = new Set(files.map((f) => f.path));
	for (const path of untracked.data.split("\0")) {
		if (path && !seen.has(path)) files.push({ path, status: "added" });
	}
	return ok({ top: facts.toplevel, mergeBase: mb, files });
}
