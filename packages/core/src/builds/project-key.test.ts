import { describe, expect, test } from "bun:test";
import type { Exec } from "../exec";
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
	test("reads toplevel + origin via exec", async () => {
		const calls: string[] = [];
		const exec: Exec = async (cmd, opts) => {
			calls.push(`${opts?.cwd} ${cmd.join(" ")}`);
			const joined = cmd.join(" ");
			if (joined === "git rev-parse --show-toplevel") return { exitCode: 0, stdout: "/w/wt\n", stderr: "" };
			if (joined === "git rev-parse --git-common-dir") return { exitCode: 0, stdout: "/w/main/.git\n", stderr: "" };
			if (joined === "git config --get remote.origin.url")
				return { exitCode: 0, stdout: "git@github.com:o/r.git\n", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		expect(await readProjectKey(exec, "/w/wt/app")).toEqual({ success: true, data: "github.com/o/r:app" });
		expect(calls[0]).toBe("/w/wt/app git rev-parse --show-toplevel");
	});

	test("falls back to the first remote, then to the path", async () => {
		const exec: Exec = async (cmd) => {
			const joined = cmd.join(" ");
			if (joined === "git rev-parse --show-toplevel") return { exitCode: 0, stdout: "/w", stderr: "" };
			if (joined === "git remote") return { exitCode: 0, stdout: "upstream\n", stderr: "" };
			if (joined === "git config --get remote.upstream.url")
				return { exitCode: 0, stdout: "https://github.com/o/r", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "" };
		};
		expect(await readProjectKey(exec, "/w")).toEqual({ success: true, data: "github.com/o/r:." });
		const none: Exec = async () => ({ exitCode: 128, stdout: "", stderr: "not a git repo" });
		expect(await readProjectKey(none, "/tmp/x")).toEqual({ success: true, data: "path:/tmp/x" });
	});
});
