import { describe, expect, test } from "bun:test";
import { detectOwner, parseGitInfo } from "./owner";

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
