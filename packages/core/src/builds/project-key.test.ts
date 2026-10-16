import { describe, expect, test } from "bun:test";
import type { Exec } from "../exec";
import { createGitFactsCache, readGitFacts } from "../git-facts";
import { normaliseRemote, projectKey, readProjectKey, safeKey } from "./project-key";

describe("normaliseRemote", () => {
	test("ssh scp-style, https and ssh:// all agree", () => {
		const want = "github.com/delacournz/warden";
		for (const url of [
			"git@github.com:delacournz/warden.git",
			"git@github.com:delacournz/warden",
			"https://github.com/delacournz/warden",
			"https://github.com/delacournz/warden.git",
			"https://github.com/DelacourNZ/Warden/",
			"https://user:token@github.com/delacournz/warden.git",
			"ssh://git@github.com/delacournz/warden",
			"ssh://git@github.com:22/delacournz/warden.git",
			"  git@github.com:delacournz/warden.git\n",
		]) {
			expect(normaliseRemote(url)).toBe(want);
		}
	});

	test("different repos / hosts differ", () => {
		expect(normaliseRemote("git@github.com:o/a.git")).not.toBe(normaliseRemote("git@github.com:o/b.git"));
		expect(normaliseRemote("git@gitlab.com:o/a.git")).not.toBe(normaliseRemote("git@github.com:o/a.git"));
	});
});

describe("projectKey", () => {
	const remote = "git@github.com:o/mono.git";

	test("same app in two worktrees → same key", () => {
		const a = projectKey({ remote, toplevel: "/w/cowrie", root: "/w/cowrie/apps/salient/app" });
		const b = projectKey({
			remote: "https://github.com/o/mono",
			toplevel: "/Users/x/orca/needlefish",
			root: "/Users/x/orca/needlefish/apps/salient/app",
		});
		expect(a).toBe("github.com/o/mono:apps/salient/app");
		expect(b).toBe(a);
	});

	test("different subpaths / repos never collide", () => {
		const app = projectKey({ remote, toplevel: "/w", root: "/w/apps/a" });
		expect(projectKey({ remote, toplevel: "/w", root: "/w/apps/b" })).not.toBe(app);
		expect(projectKey({ remote: "git@github.com:o/other.git", toplevel: "/w", root: "/w/apps/a" })).not.toBe(app);
		expect(projectKey({ remote, toplevel: "/w", root: "/w" })).toBe("github.com/o/mono:.");
	});

	test("no remote → shared git dir; outside git → path", () => {
		expect(projectKey({ toplevel: "/w/wt2", commonDir: "/w/main/.git", root: "/w/wt2/app" })).toBe(
			"git:/w/main/.git:app"
		);
		expect(projectKey({ root: "/tmp/x" })).toBe("path:/tmp/x");
	});
});

describe("safeKey", () => {
	test("filesystem-safe and distinct for keys that sanitise alike", () => {
		const a = safeKey("github.com/o/r:apps/a");
		expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
		expect(a.startsWith("github.com_o_r_apps_a-")).toBe(true);
		expect(safeKey("github.com/o/r:apps_a")).not.toBe(a);
		expect(safeKey("github.com/o/r:apps/a")).toBe(a);
	});
});

describe("readProjectKey", () => {
	const COMBINED = "git rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD";

	test("reads toplevel + origin via exec", async () => {
		const calls: string[] = [];
		const exec: Exec = async (cmd, opts) => {
			calls.push(`${opts?.cwd} ${cmd.join(" ")}`);
			const joined = cmd.join(" ");
			if (joined === COMBINED) return { exitCode: 0, stdout: "/w/wt\n/w/main/.git\nrefs/heads/x\n", stderr: "" };
			if (joined === "git config --get remote.origin.url")
				return { exitCode: 0, stdout: "git@github.com:o/r.git\n", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		expect(await readProjectKey(exec, "/w/wt/app", createGitFactsCache())).toEqual({
			success: true,
			data: "github.com/o/r:app",
		});
		expect(calls[0]).toBe(`/w/wt/app ${COMBINED}`);
	});

	test("a project key costs two spawns: one rev-parse and the remote", async () => {
		const calls: string[] = [];
		const exec: Exec = async (cmd) => {
			calls.push(cmd.join(" "));
			if (cmd.join(" ") === COMBINED) return { exitCode: 0, stdout: "/w\n/w/.git\nrefs/heads/main\n", stderr: "" };
			return { exitCode: 0, stdout: "https://github.com/o/r\n", stderr: "" };
		};
		await readProjectKey(exec, "/w", createGitFactsCache());
		expect(calls).toEqual([COMBINED, "git config --get remote.origin.url"]);
	});

	test("the checkout facts are reused from the cache: only the remote is spawned again", async () => {
		const calls: string[] = [];
		const exec: Exec = async (cmd) => {
			calls.push(cmd.join(" "));
			if (cmd.join(" ") === COMBINED) return { exitCode: 0, stdout: "/w\n/w/.git\nrefs/heads/main\n", stderr: "" };
			return { exitCode: 0, stdout: "https://github.com/o/r\n", stderr: "" };
		};
		const cache = createGitFactsCache();
		await readGitFacts(exec, "/w", cache);
		await readProjectKey(exec, "/w", cache);
		expect(calls.filter((c) => c === COMBINED)).toHaveLength(1);
		expect(calls).toHaveLength(2);
	});

	test("falls back to the first remote, then to the path", async () => {
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			if (joined === COMBINED) return { exitCode: 0, stdout: "/w\n/w/.git\nrefs/heads/main\n", stderr: "" };
			if (joined === "git remote") return { exitCode: 0, stdout: "upstream\n", stderr: "" };
			if (joined === "git config --get remote.upstream.url")
				return { exitCode: 0, stdout: "https://github.com/o/r", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		expect(await readProjectKey(exec, "/w", createGitFactsCache())).toEqual({
			success: true,
			data: "github.com/o/r:.",
		});
		const none: Exec = async () => ({ exitCode: 128, stdout: "", stderr: "not a git repo" });
		expect(await readProjectKey(none, "/nonexistent-warden-test/x", createGitFactsCache())).toEqual({
			success: true,
			data: "path:/nonexistent-warden-test/x",
		});
	});

	test("no remote at all keys by the shared git dir", async () => {
		const exec: Exec = async (cmd) =>
			cmd.join(" ") === COMBINED
				? { exitCode: 0, stdout: "/w/wt\n/w/main/.git\nHEAD\n", stderr: "" }
				: { exitCode: 1, stdout: "", stderr: "" };
		expect(await readProjectKey(exec, "/w/wt", createGitFactsCache())).toEqual({
			success: true,
			data: "git:/w/main/.git:.",
		});
	});
});
