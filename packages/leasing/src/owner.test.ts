import { afterEach, describe, expect, test } from "bun:test";
import { GitFactsCache, type GitSyncRun } from "@delacour/warden-runtime/git-facts";
import { detectOwner, leasePidFor, parseGitInfo, readGitInfo, resolveOwner } from "./owner";
import { type TestLeaseHost, testLeaseHost } from "./testing/lease-host.testing";

let ctx: TestLeaseHost | undefined;
afterEach(() => ctx?.cleanup());

const base = { pid: 100, ppid: 50, cwd: "/work/app", env: {} };

describe("detectOwner", () => {
	test("hook session id wins", () => {
		expect(detectOwner({ ...base, sessionId: "hook-s", env: { CLAUDE_CODE_SESSION_ID: "env-s" } })).toEqual({
			kind: "agent",
			sessionId: "hook-s",
			cwd: "/work/app",
		});
	});

	test("claude env session id", () => {
		expect(detectOwner({ ...base, env: { CLAUDE_CODE_SESSION_ID: "env-s" } })).toMatchObject({
			kind: "agent",
			sessionId: "env-s",
		});
		expect(detectOwner({ ...base, env: { CLAUDE_SESSION_ID: "old" } })).toMatchObject({ sessionId: "old" });
		expect(detectOwner({ ...base, env: { WARDEN_SESSION_ID: "w" } })).toMatchObject({ sessionId: "w" });
	});

	test("CI", () => {
		expect(detectOwner({ ...base, env: { CI: "true", GITHUB_RUN_ID: "123" } })).toEqual({ kind: "ci", runId: "123" });
		expect(detectOwner({ ...base, env: { CI: "1" } })).toEqual({ kind: "ci", runId: "ci" });
	});

	test("falls back to user with parent pid", () => {
		expect(detectOwner({ ...base, env: { TTY: "/dev/ttys001" } })).toEqual({
			kind: "user",
			pid: 50,
			tty: "/dev/ttys001",
			cwd: "/work/app",
		});
	});

	test("git info populates repo + worktree", () => {
		expect(
			detectOwner({ ...base, env: { CLAUDE_CODE_SESSION_ID: "s" }, git: { repo: "warden", worktree: "cowrie@main" } })
		).toEqual({ kind: "agent", sessionId: "s", cwd: "/work/app", repo: "warden", worktree: "cowrie@main" });
	});
});

describe("parseGitInfo", () => {
	test("linked worktree: repo from common dir, worktree from toplevel + branch", () => {
		expect(
			parseGitInfo({
				toplevel: "/Users/c/orca/workspaces/warden/cowrie",
				commonDir: "/Users/c/code/warden/.git",
				branch: "feature/cowrie",
			})
		).toEqual({ repo: "warden", worktree: "cowrie@feature/cowrie" });
	});

	test("main checkout", () => {
		expect(parseGitInfo({ toplevel: "/code/warden", commonDir: "/code/warden/.git", branch: "main" })).toEqual({
			repo: "warden",
			worktree: "warden@main",
		});
	});

	test("detached head", () => {
		expect(parseGitInfo({ toplevel: "/code/warden", commonDir: "/code/warden/.git", branch: "" })).toEqual({
			repo: "warden",
			worktree: "warden",
		});
	});
});

describe("readGitInfo", () => {
	const COMBINED = "rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD";

	/** Fake sync git: one canned answer per argv, every spawn recorded. */
	function fakeRun(answers: Record<string, { exitCode?: number; stdout: string }>) {
		const spawns: string[] = [];
		const run: GitSyncRun = (_cwd, args) => {
			const joined = args.join(" ");
			spawns.push(joined);
			const answer = answers[joined];
			return answer ? { exitCode: answer.exitCode ?? 0, stdout: answer.stdout } : { exitCode: 128, stdout: "" };
		};
		return { spawns, run };
	}

	test("owner resolution is one git spawn", () => {
		const git = fakeRun({ [COMBINED]: { stdout: "/w/cowrie\n/code/warden/.git\nrefs/heads/feature/cowrie\n" } });
		const info = readGitInfo("/w/cowrie/app", { run: git.run, cache: new GitFactsCache() });
		expect(info).toEqual({ repo: "warden", worktree: "cowrie@feature/cowrie" });
		expect(git.spawns).toEqual([COMBINED]);
	});

	test("a second resolution of the same cwd spawns nothing", () => {
		const git = fakeRun({ [COMBINED]: { stdout: "/code/warden\n/code/warden/.git\nrefs/heads/main\n" } });
		const cache = new GitFactsCache();
		const first = readGitInfo("/code/warden", { run: git.run, cache });
		const second = readGitInfo("/code/warden", { run: git.run, cache });
		expect(second).toEqual(first);
		expect(git.spawns).toHaveLength(1);
	});

	test("detached HEAD drops the branch from the worktree label", () => {
		const git = fakeRun({ [COMBINED]: { stdout: "/code/warden\n/code/warden/.git\nHEAD\n" } });
		expect(readGitInfo("/code/warden", { run: git.run, cache: new GitFactsCache() })).toEqual({
			repo: "warden",
			worktree: "warden",
		});
		expect(git.spawns).toHaveLength(1);
	});

	test("an empty repo (no commit yet) still resolves, with the old branch call", () => {
		const git = fakeRun({
			[COMBINED]: { exitCode: 128, stdout: "/code/new\n/code/new/.git\n" },
			"branch --show-current": { stdout: "main\n" },
		});
		expect(readGitInfo("/code/new", { run: git.run, cache: new GitFactsCache() })).toEqual({
			repo: "new",
			worktree: "new@main",
		});
		expect(git.spawns).toEqual([COMBINED, "branch --show-current"]);
	});

	test("outside git there is no info, after one spawn", () => {
		const git = fakeRun({});
		expect(readGitInfo("/tmp/plain", { run: git.run, cache: new GitFactsCache() })).toBeUndefined();
		expect(git.spawns).toHaveLength(1);
	});
});

describe("resolveOwner", () => {
	test("session env → agent; otherwise user = parent pid", () => {
		ctx = testLeaseHost();
		expect(resolveOwner({ ...ctx, env: { WARDEN_SESSION_ID: "abc" } })).toMatchObject({
			kind: "agent",
			sessionId: "abc",
		});
		expect(resolveOwner(ctx, "hook-1")).toMatchObject({ kind: "agent", sessionId: "hook-1" });
		const user = resolveOwner(ctx);
		expect(user).toMatchObject({ kind: "user", pid: process.ppid });
		expect(leasePidFor(user)).toBe(process.ppid);
		expect(leasePidFor({ kind: "agent", sessionId: "x", cwd: "/" })).toBeUndefined();
	});
});

describe("resolveOwner git facts", () => {
	test("repo and worktree come from the command's git cache, with no git spawn of their own", () => {
		ctx = testLeaseHost();
		ctx.git.store(ctx.cwd, { toplevel: "/w/app", commonDir: "/w/main/.git", branch: "feat" });
		expect(resolveOwner({ ...ctx, env: { WARDEN_SESSION_ID: "abc" } })).toMatchObject({
			kind: "agent",
			repo: "main",
			worktree: "app@feat",
		});
		expect(resolveOwner(ctx)).toMatchObject({ kind: "user", repo: "main", worktree: "app@feat" });
	});

	test("a cache of another command is not consulted", () => {
		ctx = testLeaseHost();
		const other = testLeaseHost();
		try {
			other.git.store(other.cwd, { toplevel: "/w/app", commonDir: "/w/main/.git", branch: "feat" });
			expect(resolveOwner({ ...ctx, cwd: other.cwd })).not.toHaveProperty("repo");
		} finally {
			other.cleanup();
		}
	});
});
