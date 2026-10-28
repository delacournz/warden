import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

/** Real git on temp dirs, with an identity and no user config. Throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
	const out = Bun.spawnSync(["git", ...args], {
		cwd,
		env: { ...process.env, ...GIT_ENV },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${out.stderr.toString()}`);
	return out.stdout.toString().trim();
}

export type Fixture = {
	root: string;
	/** the main checkout, on `main`, tracking `origin` */
	repo: string;
	origin: string;
	/** `git worktree add -b <branch>` under `$root/wt/<branch>`; the branch is cut from the current `main` */
	addWorktree(branch: string): string;
	/** commit a file in `dir` */
	commit(dir: string, file: string): string;
	cleanup(): void;
};

export function fixtureRepo(): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "warden-wt-")));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	mkdirSync(join(root, "wt"));
	git(root, "init", "--bare", "-b", "main", origin);
	git(root, "clone", origin, repo);
	git(repo, "checkout", "-B", "main");
	const commit = (dir: string, file: string): string => {
		writeFileSync(join(dir, file), `${file}\n`);
		git(dir, "add", file);
		git(dir, "commit", "-m", file);
		return git(dir, "rev-parse", "HEAD");
	};
	commit(repo, "base.txt");
	git(repo, "push", "-u", "origin", "main");
	git(repo, "remote", "set-head", "origin", "main");
	return {
		root,
		repo,
		origin,
		addWorktree(branch) {
			const path = join(root, "wt", branch);
			git(repo, "worktree", "add", "-b", branch, path, "main");
			return path;
		},
		commit,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

export type FakeTools = {
	/** `lsof -d cwd -Fn` stdout; `undefined` = lsof cannot run (exit 127) */
	lsof?: string;
	/** branch → `gh pr list` JSON stdout; a missing branch is `[]`; `undefined` = gh missing */
	gh?: Record<string, string> | undefined;
	calls?: string[][];
};

/** Real git, fake `lsof` and `gh`; everything else runs for real. */
export function execWithFakes(real: Exec, tools: FakeTools): Exec {
	return async (cmd, opts): Promise<ExecResult> => {
		tools.calls?.push([...cmd]);
		const [bin] = cmd;
		if (bin === "lsof") {
			return tools.lsof === undefined
				? { exitCode: 127, stdout: "", stderr: "no lsof" }
				: { exitCode: 0, stdout: tools.lsof, stderr: "" };
		}
		if (bin === "gh") {
			if (tools.gh === undefined) return { exitCode: 127, stdout: "", stderr: "no gh" };
			const head = cmd[cmd.indexOf("--head") + 1] ?? "";
			return { exitCode: 0, stdout: tools.gh[head] ?? "[]", stderr: "" };
		}
		return real(cmd, opts);
	};
}
