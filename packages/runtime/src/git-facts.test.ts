import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, type ExecResult, processExec } from "./exec";
import { GitFactsCache, type GitSyncRun, gitFactsReader } from "./git-facts";

const COMBINED = "git rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD";

type Reply = Partial<ExecResult>;

/** A fake git: answers by the joined argv, records `cwd argv` per spawn, exit 128 for anything unknown. */
function fakeGit(replies: Record<string, Reply>) {
	const calls: string[] = [];
	const answer = (cwd: string | undefined, cmd: readonly string[]): ExecResult => {
		const joined = cmd.join(" ");
		calls.push(`${cwd} ${joined}`);
		const reply = replies[joined];
		return reply
			? { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" }
			: { exitCode: 128, stdout: "", stderr: "fatal" };
	};
	const exec: Exec = async (cmd, opts) => answer(opts?.cwd, cmd);
	const run: GitSyncRun = (cwd, args) => {
		const res = answer(cwd, ["git", ...args]);
		return { exitCode: res.exitCode, stdout: res.stdout };
	};
	return { calls, exec, run };
}

const checkout = { [COMBINED]: { stdout: "/w/app\n/w/main/.git\nrefs/heads/feature/x\n" } };

describe("gitFactsReader.read (async)", () => {
	test("one spawn: toplevel, common dir and branch", async () => {
		const git = fakeGit(checkout);
		const facts = await gitFactsReader.read(git.exec, "/w/app/src", new GitFactsCache());
		expect(facts).toEqual({ toplevel: "/w/app", commonDir: "/w/main/.git", branch: "feature/x" });
		expect(git.calls).toEqual([`/w/app/src ${COMBINED}`]);
	});

	test("a relative common dir resolves against the cwd", async () => {
		const git = fakeGit({ [COMBINED]: { stdout: "/w/app\n../.git\nrefs/heads/main\n" } });
		const facts = await gitFactsReader.read(git.exec, "/w/app/sub", new GitFactsCache());
		expect(facts?.commonDir).toBe("/w/app/.git");
	});

	test("detached HEAD prints `HEAD`: the branch is empty, like `branch --show-current`", async () => {
		const git = fakeGit({ [COMBINED]: { stdout: "/w/app\n/w/app/.git\nHEAD\n" } });
		const facts = await gitFactsReader.read(git.exec, "/w/app", new GitFactsCache());
		expect(facts?.branch).toBe("");
		expect(git.calls).toHaveLength(1);
	});

	test("a branch that shares its name with a tag keeps its plain name", async () => {
		const git = fakeGit({ [COMBINED]: { stdout: "/w/app\n/w/app/.git\nrefs/heads/release\n" } });
		expect((await gitFactsReader.read(git.exec, "/w/app", new GitFactsCache()))?.branch).toBe("release");
	});

	test("before the first commit HEAD cannot be resolved: only the branch is asked for again", async () => {
		const git = fakeGit({
			[COMBINED]: { exitCode: 128, stdout: "/w/app\n/w/app/.git\n", stderr: "fatal: ambiguous argument 'HEAD'" },
			"git branch --show-current": { stdout: "main\n" },
		});
		const facts = await gitFactsReader.read(git.exec, "/w/app", new GitFactsCache());
		expect(facts).toEqual({ toplevel: "/w/app", commonDir: "/w/app/.git", branch: "main" });
		expect(git.calls).toEqual([`/w/app ${COMBINED}`, "/w/app git branch --show-current"]);
	});

	test("an odd partial answer falls back to the three old calls", async () => {
		const git = fakeGit({
			[COMBINED]: { exitCode: 128, stdout: "/w/app\n" },
			"git rev-parse --show-toplevel": { stdout: "/w/app\n" },
			"git rev-parse --git-common-dir": { stdout: ".git\n" },
			"git branch --show-current": { stdout: "dev\n" },
		});
		const facts = await gitFactsReader.read(git.exec, "/w/app", new GitFactsCache());
		expect(facts).toEqual({ toplevel: "/w/app", commonDir: "/w/app/.git", branch: "dev" });
		expect(git.calls).toHaveLength(4);
	});

	test("the fallback gives up when the toplevel cannot be read", async () => {
		const git = fakeGit({ [COMBINED]: { exitCode: 128, stdout: "/w/app\n" } });
		expect(await gitFactsReader.read(git.exec, "/w/app", new GitFactsCache())).toBeUndefined();
		expect(git.calls).toHaveLength(2);
	});

	test("not a git checkout: one spawn, no fallback", async () => {
		const git = fakeGit({});
		expect(await gitFactsReader.read(git.exec, "/tmp/plain", new GitFactsCache())).toBeUndefined();
		expect(git.calls).toEqual([`/tmp/plain ${COMBINED}`]);
	});
});

describe("memoising", () => {
	test("a second read of the same cwd spawns nothing", async () => {
		const git = fakeGit(checkout);
		const cache = new GitFactsCache();
		const first = await gitFactsReader.read(git.exec, "/w/app", cache);
		const second = await gitFactsReader.read(git.exec, "/w/app", cache);
		expect(second).toEqual(first);
		expect(git.calls).toHaveLength(1);
	});

	test("another cwd is read separately", async () => {
		const git = fakeGit(checkout);
		const cache = new GitFactsCache();
		await gitFactsReader.read(git.exec, "/w/app", cache);
		await gitFactsReader.read(git.exec, "/w/app/other", cache);
		expect(git.calls).toHaveLength(2);
	});

	test("a read inside a checkout also answers for its toplevel", async () => {
		const git = fakeGit(checkout);
		const cache = new GitFactsCache();
		await gitFactsReader.read(git.exec, "/w/app/src", cache);
		expect(await gitFactsReader.read(git.exec, "/w/app", cache)).toEqual({
			toplevel: "/w/app",
			commonDir: "/w/main/.git",
			branch: "feature/x",
		});
		expect(git.calls).toEqual([`/w/app/src ${COMBINED}`]);
	});

	test("the toplevel alias of a relative common dir is absolute, and a non-checkout makes no alias", async () => {
		const git = fakeGit({ [COMBINED]: { stdout: "/w/app\n../.git\nrefs/heads/main\n" } });
		const cache = new GitFactsCache();
		await gitFactsReader.read(git.exec, "/w/app/sub", cache);
		expect((await gitFactsReader.read(git.exec, "/w/app", cache))?.commonDir).toBe("/w/app/.git");
		const none = fakeGit({});
		await gitFactsReader.read(none.exec, "/tmp/plain/sub", cache);
		await gitFactsReader.read(none.exec, "/tmp/plain", cache);
		expect(none.calls).toHaveLength(2);
	});

	test("concurrent reads of one cwd share a single spawn", async () => {
		const git = fakeGit(checkout);
		const cache = new GitFactsCache();
		const all = await Promise.all([1, 2, 3, 4].map(() => gitFactsReader.read(git.exec, "/w/app", cache)));
		expect(new Set(all.map((f) => f?.branch))).toEqual(new Set(["feature/x"]));
		expect(git.calls).toHaveLength(1);
	});

	test("a non-checkout is remembered too", async () => {
		const git = fakeGit({});
		const cache = new GitFactsCache();
		await gitFactsReader.read(git.exec, "/tmp/plain", cache);
		await gitFactsReader.read(git.exec, "/tmp/plain", cache);
		expect(git.calls).toHaveLength(1);
	});

	test("an entry older than the ttl is read again (long-lived processes see branch changes)", async () => {
		const git = fakeGit(checkout);
		let now = 1_000;
		const cache = new GitFactsCache({ ttlMs: 5_000, now: () => now });
		await gitFactsReader.read(git.exec, "/w/app", cache);
		now += 4_999;
		await gitFactsReader.read(git.exec, "/w/app", cache);
		expect(git.calls).toHaveLength(1);
		now += 1;
		await gitFactsReader.read(git.exec, "/w/app", cache);
		expect(git.calls).toHaveLength(2);
	});

	test("ttl 0 turns the cache off", async () => {
		const git = fakeGit(checkout);
		const cache = new GitFactsCache({ ttlMs: 0 });
		await gitFactsReader.read(git.exec, "/w/app", cache);
		await gitFactsReader.read(git.exec, "/w/app", cache);
		expect(git.calls).toHaveLength(2);
	});

	test("separate caches do not share entries", async () => {
		const git = fakeGit(checkout);
		await gitFactsReader.read(git.exec, "/w/app", new GitFactsCache());
		await gitFactsReader.read(git.exec, "/w/app", new GitFactsCache());
		expect(git.calls).toHaveLength(2);
	});
});

describe("gitFactsReader.readSync", () => {
	test("one spawn, same facts as the async read", async () => {
		const git = fakeGit(checkout);
		const facts = gitFactsReader.readSync("/w/app/src", { run: git.run, cache: new GitFactsCache() });
		expect(facts).toEqual({ toplevel: "/w/app", commonDir: "/w/main/.git", branch: "feature/x" });
		expect(git.calls).toEqual([`/w/app/src ${COMBINED}`]);
	});

	test("detached HEAD and an empty repo map the same way", () => {
		const detached = fakeGit({ [COMBINED]: { stdout: "/w/app\n/w/app/.git\nHEAD\n" } });
		expect(gitFactsReader.readSync("/w/app", { run: detached.run, cache: new GitFactsCache() })?.branch).toBe("");
		const empty = fakeGit({
			[COMBINED]: { exitCode: 128, stdout: "/w/app\n/w/app/.git\n" },
			"git branch --show-current": { stdout: "trunk\n" },
		});
		expect(gitFactsReader.readSync("/w/app", { run: empty.run, cache: new GitFactsCache() })?.branch).toBe("trunk");
		expect(empty.calls).toHaveLength(2);
	});

	test("not a git checkout is undefined after one spawn", () => {
		const git = fakeGit({});
		expect(gitFactsReader.readSync("/tmp/plain", { run: git.run, cache: new GitFactsCache() })).toBeUndefined();
		expect(git.calls).toHaveLength(1);
	});

	test("a second read spawns nothing", () => {
		const git = fakeGit(checkout);
		const cache = new GitFactsCache();
		gitFactsReader.readSync("/w/app", { run: git.run, cache });
		gitFactsReader.readSync("/w/app", { run: git.run, cache });
		expect(git.calls).toHaveLength(1);
	});

	test("a sync read inside a checkout also answers for its toplevel", () => {
		const git = fakeGit(checkout);
		const cache = new GitFactsCache();
		gitFactsReader.readSync("/w/app/src", { run: git.run, cache });
		expect(gitFactsReader.readSync("/w/app", { run: git.run, cache })?.branch).toBe("feature/x");
		expect(git.calls).toHaveLength(1);
	});

	test("sync and async reads share one cache", async () => {
		const git = fakeGit(checkout);
		const cache = new GitFactsCache();
		gitFactsReader.readSync("/w/app", { run: git.run, cache });
		expect(await gitFactsReader.read(git.exec, "/w/app", cache)).toMatchObject({ branch: "feature/x" });
		expect(git.calls).toHaveLength(1);
	});

	test("against real git: one checkout, then a missing directory", () => {
		const facts = gitFactsReader.readSync(process.cwd(), { cache: new GitFactsCache() });
		expect(facts?.toplevel).toBeTruthy();
		expect(gitFactsReader.readSync("/nonexistent-warden-git-facts", { cache: new GitFactsCache() })).toBeUndefined();
	});
});

describe("against real git", () => {
	const git = (cwd: string, ...args: string[]) =>
		processExec.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
			cwd,
		});

	test("an empty repo, a branch, a detached HEAD and a plain directory", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-git-facts-")));
		try {
			await git(dir, "init", "-q", "-b", "trunk");
			expect(await gitFactsReader.read(processExec.run, dir, new GitFactsCache())).toEqual({
				toplevel: dir,
				commonDir: join(dir, ".git"),
				branch: "trunk",
			});
			await git(dir, "commit", "-q", "--allow-empty", "-m", "first");
			await git(dir, "tag", "trunk");
			expect((await gitFactsReader.read(processExec.run, dir, new GitFactsCache()))?.branch).toBe("trunk");
			expect(gitFactsReader.readSync(dir, { cache: new GitFactsCache() })?.branch).toBe("trunk");
			await git(dir, "checkout", "-q", "--detach");
			expect((await gitFactsReader.read(processExec.run, dir, new GitFactsCache()))?.branch).toBe("");
			expect(gitFactsReader.readSync(dir, { cache: new GitFactsCache() })?.branch).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "warden-git-facts-plain-")));
		try {
			expect(await gitFactsReader.read(processExec.run, plain, new GitFactsCache())).toBeUndefined();
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
