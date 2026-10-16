import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type Exec, type ExecResult } from "./exec";
import { createGitFactsCache, type GitSyncRun, readGitFacts, readGitFactsSync } from "./git-facts";

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

describe("readGitFacts (async)", () => {
	test("one spawn: toplevel, common dir and branch", async () => {
		const git = fakeGit(checkout);
		const facts = await readGitFacts(git.exec, "/w/app/src", createGitFactsCache());
		expect(facts).toEqual({ toplevel: "/w/app", commonDir: "/w/main/.git", branch: "feature/x" });
		expect(git.calls).toEqual([`/w/app/src ${COMBINED}`]);
	});

	test("a relative common dir resolves against the cwd", async () => {
		const git = fakeGit({ [COMBINED]: { stdout: "/w/app\n../.git\nrefs/heads/main\n" } });
		const facts = await readGitFacts(git.exec, "/w/app/sub", createGitFactsCache());
		expect(facts?.commonDir).toBe("/w/app/.git");
	});

	test("detached HEAD prints `HEAD`: the branch is empty, like `branch --show-current`", async () => {
		const git = fakeGit({ [COMBINED]: { stdout: "/w/app\n/w/app/.git\nHEAD\n" } });
		const facts = await readGitFacts(git.exec, "/w/app", createGitFactsCache());
		expect(facts?.branch).toBe("");
		expect(git.calls).toHaveLength(1);
	});

	test("a branch that shares its name with a tag keeps its plain name", async () => {
		const git = fakeGit({ [COMBINED]: { stdout: "/w/app\n/w/app/.git\nrefs/heads/release\n" } });
		expect((await readGitFacts(git.exec, "/w/app", createGitFactsCache()))?.branch).toBe("release");
	});

	test("before the first commit HEAD cannot be resolved: only the branch is asked for again", async () => {
		const git = fakeGit({
			[COMBINED]: { exitCode: 128, stdout: "/w/app\n/w/app/.git\n", stderr: "fatal: ambiguous argument 'HEAD'" },
			"git branch --show-current": { stdout: "main\n" },
		});
		const facts = await readGitFacts(git.exec, "/w/app", createGitFactsCache());
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
		const facts = await readGitFacts(git.exec, "/w/app", createGitFactsCache());
		expect(facts).toEqual({ toplevel: "/w/app", commonDir: "/w/app/.git", branch: "dev" });
		expect(git.calls).toHaveLength(4);
	});

	test("the fallback gives up when the toplevel cannot be read", async () => {
		const git = fakeGit({ [COMBINED]: { exitCode: 128, stdout: "/w/app\n" } });
		expect(await readGitFacts(git.exec, "/w/app", createGitFactsCache())).toBeUndefined();
		expect(git.calls).toHaveLength(2);
	});

	test("not a git checkout: one spawn, no fallback", async () => {
		const git = fakeGit({});
		expect(await readGitFacts(git.exec, "/tmp/plain", createGitFactsCache())).toBeUndefined();
		expect(git.calls).toEqual([`/tmp/plain ${COMBINED}`]);
	});
});

describe("memoising", () => {
	test("a second read of the same cwd spawns nothing", async () => {
		const git = fakeGit(checkout);
		const cache = createGitFactsCache();
		const first = await readGitFacts(git.exec, "/w/app", cache);
		const second = await readGitFacts(git.exec, "/w/app", cache);
		expect(second).toEqual(first);
		expect(git.calls).toHaveLength(1);
	});

	test("another cwd is read separately", async () => {
		const git = fakeGit(checkout);
		const cache = createGitFactsCache();
		await readGitFacts(git.exec, "/w/app", cache);
		await readGitFacts(git.exec, "/w/app/other", cache);
		expect(git.calls).toHaveLength(2);
	});

	test("a read inside a checkout also answers for its toplevel", async () => {
		const git = fakeGit(checkout);
		const cache = createGitFactsCache();
		await readGitFacts(git.exec, "/w/app/src", cache);
		expect(await readGitFacts(git.exec, "/w/app", cache)).toEqual({
			toplevel: "/w/app",
			commonDir: "/w/main/.git",
			branch: "feature/x",
		});
		expect(git.calls).toEqual([`/w/app/src ${COMBINED}`]);
	});

	test("the toplevel alias of a relative common dir is absolute, and a non-checkout makes no alias", async () => {
		const git = fakeGit({ [COMBINED]: { stdout: "/w/app\n../.git\nrefs/heads/main\n" } });
		const cache = createGitFactsCache();
		await readGitFacts(git.exec, "/w/app/sub", cache);
		expect((await readGitFacts(git.exec, "/w/app", cache))?.commonDir).toBe("/w/app/.git");
		const none = fakeGit({});
		await readGitFacts(none.exec, "/tmp/plain/sub", cache);
		await readGitFacts(none.exec, "/tmp/plain", cache);
		expect(none.calls).toHaveLength(2);
	});

	test("concurrent reads of one cwd share a single spawn", async () => {
		const git = fakeGit(checkout);
		const cache = createGitFactsCache();
		const all = await Promise.all([1, 2, 3, 4].map(() => readGitFacts(git.exec, "/w/app", cache)));
		expect(new Set(all.map((f) => f?.branch))).toEqual(new Set(["feature/x"]));
		expect(git.calls).toHaveLength(1);
	});

	test("a non-checkout is remembered too", async () => {
		const git = fakeGit({});
		const cache = createGitFactsCache();
		await readGitFacts(git.exec, "/tmp/plain", cache);
		await readGitFacts(git.exec, "/tmp/plain", cache);
		expect(git.calls).toHaveLength(1);
	});

	test("an entry older than the ttl is read again (long-lived processes see branch changes)", async () => {
		const git = fakeGit(checkout);
		let now = 1_000;
		const cache = createGitFactsCache({ ttlMs: 5_000, now: () => now });
		await readGitFacts(git.exec, "/w/app", cache);
		now += 4_999;
		await readGitFacts(git.exec, "/w/app", cache);
		expect(git.calls).toHaveLength(1);
		now += 1;
		await readGitFacts(git.exec, "/w/app", cache);
		expect(git.calls).toHaveLength(2);
	});

	test("ttl 0 turns the cache off", async () => {
		const git = fakeGit(checkout);
		const cache = createGitFactsCache({ ttlMs: 0 });
		await readGitFacts(git.exec, "/w/app", cache);
		await readGitFacts(git.exec, "/w/app", cache);
		expect(git.calls).toHaveLength(2);
	});

	test("separate caches do not share entries", async () => {
		const git = fakeGit(checkout);
		await readGitFacts(git.exec, "/w/app", createGitFactsCache());
		await readGitFacts(git.exec, "/w/app", createGitFactsCache());
		expect(git.calls).toHaveLength(2);
	});
});

describe("readGitFactsSync", () => {
	test("one spawn, same facts as the async read", async () => {
		const git = fakeGit(checkout);
		const facts = readGitFactsSync("/w/app/src", { run: git.run, cache: createGitFactsCache() });
		expect(facts).toEqual({ toplevel: "/w/app", commonDir: "/w/main/.git", branch: "feature/x" });
		expect(git.calls).toEqual([`/w/app/src ${COMBINED}`]);
	});

	test("detached HEAD and an empty repo map the same way", () => {
		const detached = fakeGit({ [COMBINED]: { stdout: "/w/app\n/w/app/.git\nHEAD\n" } });
		expect(readGitFactsSync("/w/app", { run: detached.run, cache: createGitFactsCache() })?.branch).toBe("");
		const empty = fakeGit({
			[COMBINED]: { exitCode: 128, stdout: "/w/app\n/w/app/.git\n" },
			"git branch --show-current": { stdout: "trunk\n" },
		});
		expect(readGitFactsSync("/w/app", { run: empty.run, cache: createGitFactsCache() })?.branch).toBe("trunk");
		expect(empty.calls).toHaveLength(2);
	});

	test("not a git checkout is undefined after one spawn", () => {
		const git = fakeGit({});
		expect(readGitFactsSync("/tmp/plain", { run: git.run, cache: createGitFactsCache() })).toBeUndefined();
		expect(git.calls).toHaveLength(1);
	});

	test("a second read spawns nothing", () => {
		const git = fakeGit(checkout);
		const cache = createGitFactsCache();
		readGitFactsSync("/w/app", { run: git.run, cache });
		readGitFactsSync("/w/app", { run: git.run, cache });
		expect(git.calls).toHaveLength(1);
	});

	test("a sync read inside a checkout also answers for its toplevel", () => {
		const git = fakeGit(checkout);
		const cache = createGitFactsCache();
		readGitFactsSync("/w/app/src", { run: git.run, cache });
		expect(readGitFactsSync("/w/app", { run: git.run, cache })?.branch).toBe("feature/x");
		expect(git.calls).toHaveLength(1);
	});

	test("sync and async reads share one cache", async () => {
		const git = fakeGit(checkout);
		const cache = createGitFactsCache();
		readGitFactsSync("/w/app", { run: git.run, cache });
		expect(await readGitFacts(git.exec, "/w/app", cache)).toMatchObject({ branch: "feature/x" });
		expect(git.calls).toHaveLength(1);
	});

	test("against real git: one checkout, then a missing directory", () => {
		const facts = readGitFactsSync(process.cwd(), { cache: createGitFactsCache() });
		expect(facts?.toplevel).toBeTruthy();
		expect(readGitFactsSync("/nonexistent-warden-git-facts", { cache: createGitFactsCache() })).toBeUndefined();
	});
});

describe("against real git", () => {
	const git = (cwd: string, ...args: string[]) =>
		bunExec(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd });

	test("an empty repo, a branch, a detached HEAD and a plain directory", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-git-facts-")));
		try {
			await git(dir, "init", "-q", "-b", "trunk");
			expect(await readGitFacts(bunExec, dir, createGitFactsCache())).toEqual({
				toplevel: dir,
				commonDir: join(dir, ".git"),
				branch: "trunk",
			});
			await git(dir, "commit", "-q", "--allow-empty", "-m", "first");
			await git(dir, "tag", "trunk");
			expect((await readGitFacts(bunExec, dir, createGitFactsCache()))?.branch).toBe("trunk");
			expect(readGitFactsSync(dir, { cache: createGitFactsCache() })?.branch).toBe("trunk");
			await git(dir, "checkout", "-q", "--detach");
			expect((await readGitFacts(bunExec, dir, createGitFactsCache()))?.branch).toBe("");
			expect(readGitFactsSync(dir, { cache: createGitFactsCache() })?.branch).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "warden-git-facts-plain-")));
		try {
			expect(await readGitFacts(bunExec, plain, createGitFactsCache())).toBeUndefined();
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
