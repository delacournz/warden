import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunExec } from "../exec";
import { createGitFactsCache } from "../git-facts";
import type { Lease } from "../types";
import {
	auditWorktrees,
	findRecentChange,
	parseWorktreeList,
	removeWorktrees,
	summarizeWorktreeStates,
	type WorktreeDeps,
	type WorktreeState,
} from "./audit";
import { execWithFakes, type FakeTools, type Fixture, fixtureRepo, git } from "./audit.testing";

const NOW = 1_000_000_000_000;

describe("parseWorktreeList", () => {
	test("reads main, branch, detached, locked and prunable entries", () => {
		const out = [
			"worktree /r",
			"HEAD aaa",
			"branch refs/heads/main",
			"",
			"worktree /r/wt/a",
			"HEAD bbb",
			"branch refs/heads/feat/a",
			"locked in use by agent",
			"",
			"worktree /r/wt/b",
			"HEAD ccc",
			"detached",
			"prunable gitdir file points to non-existent location",
			"",
			"worktree /r/bare",
			"bare",
			"",
		].join("\n");
		expect(parseWorktreeList(out)).toEqual([
			{ path: "/r", head: "aaa", branch: "main", detached: false, bare: false, locked: undefined, prunable: false },
			{
				path: "/r/wt/a",
				head: "bbb",
				branch: "feat/a",
				detached: false,
				bare: false,
				locked: "in use by agent",
				prunable: false,
			},
			{ path: "/r/wt/b", head: "ccc", branch: "", detached: true, bare: false, locked: undefined, prunable: true },
			{ path: "/r/bare", head: "", branch: "", detached: false, bare: true, locked: undefined, prunable: false },
		]);
	});

	test("a bare `locked` has an empty reason", () => {
		expect(parseWorktreeList("worktree /a\nHEAD x\nlocked\n")[0]?.locked).toBe("");
	});
});

describe("auditWorktrees", () => {
	let fx: Fixture;
	beforeEach(() => {
		fx = fixtureRepo();
	});
	afterEach(() => fx.cleanup());

	function deps(tools: FakeTools = { lsof: "", gh: {} }, over: Partial<WorktreeDeps> = {}): WorktreeDeps {
		return {
			exec: execWithFakes(bunExec, tools),
			now: NOW,
			pidAlive: () => false,
			leases: [],
			cwd: fx.root,
			git: createGitFactsCache(),
			recentChange: async () => false,
			...over,
		};
	}
	const opts = { roots: [] as string[], idleMs: 3 * 86_400_000, fetch: true };

	async function stateOf(path: string, d: WorktreeDeps = deps(), o = { ...opts, roots: [fx.repo] }) {
		const audit = await auditWorktrees(d, o);
		return audit.entries.find((e) => e.path === path);
	}

	test("never lists the main checkout; a clean ancestor of origin/main is merged", async () => {
		const wt = fx.addWorktree("done");
		const audit = await auditWorktrees(deps(), { ...opts, roots: [fx.repo] });
		expect(audit.entries.map((e) => e.path)).toEqual([wt]);
		expect(audit.entries[0]).toMatchObject({ state: "merged", branch: "done", repo: join(fx.repo, ".git") });
		expect(audit.entries[0]?.evidence).toContain("origin/main");
	});

	test("a squash-merged PR (gh) is merged when its head is the worktree HEAD", async () => {
		const wt = fx.addWorktree("squashed");
		const sha = fx.commit(wt, "s.txt");
		git(wt, "push", "origin", "squashed");
		const gh = { squashed: JSON.stringify([{ number: 12, headRefOid: sha }]) };
		const e = await stateOf(wt, deps({ lsof: "", gh }));
		expect(e).toMatchObject({ state: "merged", evidence: "PR #12 merged" });
	});

	test("a merged PR whose head differs from HEAD is not merged evidence", async () => {
		const wt = fx.addWorktree("reused");
		fx.commit(wt, "r.txt");
		git(wt, "push", "origin", "reused");
		const gh = { reused: JSON.stringify([{ number: 3, headRefOid: "0".repeat(40) }]) };
		expect((await stateOf(wt, deps({ lsof: "", gh })))?.state).toBe("unmerged");
	});

	test("gh missing falls back to the ancestor check only", async () => {
		const wt = fx.addWorktree("nogh");
		fx.commit(wt, "n.txt");
		git(wt, "push", "origin", "nogh");
		expect((await stateOf(wt, deps({ lsof: "", gh: undefined })))?.state).toBe("unmerged");
	});

	test("uncommitted changes (untracked too) are review", async () => {
		const wt = fx.addWorktree("dirty");
		writeFileSync(join(wt, "scratch.txt"), "x");
		expect(await stateOf(wt)).toMatchObject({ state: "review", evidence: expect.stringContaining("uncommitted") });
	});

	test("commits on no remote are review, not merged, even with a merged PR for another head", async () => {
		const wt = fx.addWorktree("local");
		fx.commit(wt, "l.txt");
		expect(await stateOf(wt)).toMatchObject({ state: "review", evidence: "1 commit not on any remote" });
	});

	test("clean, pushed, no merge found is unmerged", async () => {
		const wt = fx.addWorktree("open");
		fx.commit(wt, "o.txt");
		git(wt, "push", "origin", "open");
		expect((await stateOf(wt))?.state).toBe("unmerged");
	});

	test("recent file changes are active, ahead of merged", async () => {
		const wt = fx.addWorktree("fresh");
		const d = deps(undefined, { recentChange: async (path) => path === wt });
		expect(await stateOf(wt, d)).toMatchObject({ state: "active" });
	});

	test("idle 0 skips the activity check", async () => {
		const wt = fx.addWorktree("zero");
		const d = deps(undefined, { recentChange: async () => true });
		expect((await stateOf(wt, d, { ...opts, idleMs: 0, roots: [fx.repo] }))?.state).toBe("merged");
	});

	test("a process with its cwd inside is in-use", async () => {
		const wt = fx.addWorktree("busy");
		const e = await stateOf(wt, deps({ lsof: `p1\nn/elsewhere\np2\nn${wt}/packages/app\n`, gh: {} }));
		expect(e).toMatchObject({ state: "in-use", evidence: "a process has its cwd inside" });
	});

	test("a cwd in a sibling with a common prefix is not inside", async () => {
		const wt = fx.addWorktree("pre");
		const e = await stateOf(wt, deps({ lsof: `n${wt}-2/x\n`, gh: {} }));
		expect(e?.state).toBe("merged");
	});

	test("lsof that cannot run makes everything in-use", async () => {
		const wt = fx.addWorktree("blind");
		const e = await stateOf(wt, deps({ lsof: undefined, gh: {} }));
		expect(e).toMatchObject({ state: "in-use", evidence: expect.stringContaining("cannot inspect") });
	});

	test("a live lease owned from inside is in-use; a dead one is not", async () => {
		const wt = fx.addWorktree("leased");
		const lease = (heartbeatAt: number): Lease => ({
			id: "l1",
			resource: { kind: "device", platform: "ios", id: "U", name: "warden-iphone-17-1" },
			owner: { kind: "agent", sessionId: "s", cwd: wt },
			acquiredAt: 0,
			heartbeatAt,
			ttlMs: 60_000,
		});
		expect(await stateOf(wt, deps(undefined, { leases: [lease(NOW)] }))).toMatchObject({
			state: "in-use",
			evidence: "live warden lease l1",
		});
		expect((await stateOf(wt, deps(undefined, { leases: [lease(0)] })))?.state).toBe("merged");
	});

	test("a locked worktree is locked, with the reason", async () => {
		const wt = fx.addWorktree("held");
		git(fx.repo, "worktree", "lock", "--reason", "agent running", wt);
		expect(await stateOf(wt)).toMatchObject({ state: "locked", evidence: "agent running" });
	});

	test("a registered worktree whose dir is gone is stale-ref", async () => {
		const wt = fx.addWorktree("gone");
		rmSync(wt, { recursive: true });
		expect(await stateOf(wt)).toMatchObject({ state: "stale-ref" });
	});

	test("nested worktrees under the repo and repos found from leases/cwd dedupe by common dir", async () => {
		const wt = fx.addWorktree("nest");
		const lease: Lease = {
			id: "l",
			resource: { kind: "port", port: 1 },
			owner: { kind: "user", pid: 1, cwd: wt },
			acquiredAt: 0,
			heartbeatAt: 0,
			ttlMs: 1,
		};
		const audit = await auditWorktrees(deps(undefined, { leases: [lease], cwd: fx.repo }), {
			...opts,
			roots: [fx.repo, wt],
		});
		expect(audit.repos).toEqual([join(fx.repo, ".git")]);
		expect(audit.entries).toHaveLength(1);
	});

	test("a --root that is not a repo is scanned one level down", async () => {
		fx.addWorktree("scan");
		const audit = await auditWorktrees(deps(), { ...opts, roots: [fx.root] });
		expect(audit.repos).toEqual([join(fx.repo, ".git")]);
	});

	test("fetch: false never runs git fetch", async () => {
		fx.addWorktree("nofetch");
		const calls: string[][] = [];
		await auditWorktrees(deps({ lsof: "", gh: {}, calls }), { ...opts, fetch: false, roots: [fx.repo] });
		expect(calls.some((c) => c[0] === "git" && c.includes("fetch"))).toBe(false);
		await auditWorktrees(deps({ lsof: "", gh: {}, calls }), { ...opts, roots: [fx.repo] });
		expect(calls.some((c) => c[0] === "git" && c.includes("fetch"))).toBe(true);
	});

	test("summarizeWorktreeStates counts per state and sums bytes", () => {
		const base = { repo: "r", mainPath: "m", branch: "b", head: "h", evidence: "" };
		const entries: WorktreeState[] = [
			{ ...base, path: "/a", state: "merged", bytes: 5 },
			{ ...base, path: "/b", state: "merged", bytes: 7 },
			{ ...base, path: "/c", state: "review" },
		];
		expect(summarizeWorktreeStates(entries)).toEqual({
			total: 3,
			byState: { merged: 2, review: 1, unmerged: 0, active: 0, "in-use": 0, locked: 0, "stale-ref": 0 },
			removable: 2,
			removableBytes: 12,
			bytes: 12,
		});
	});
});

describe("removeWorktrees", () => {
	let fx: Fixture;
	beforeEach(() => {
		fx = fixtureRepo();
	});
	afterEach(() => fx.cleanup());

	function deps(over: Partial<WorktreeDeps> = {}): WorktreeDeps {
		return {
			exec: execWithFakes(bunExec, { lsof: "", gh: {} }),
			now: NOW,
			pidAlive: () => false,
			leases: [],
			cwd: fx.root,
			git: createGitFactsCache(),
			recentChange: async () => false,
			...over,
		};
	}
	const opts = { idleMs: 0, fetch: false };
	const lease = (id: string, cwd: string, heartbeatAt: number): Lease => ({
		id,
		resource: { kind: "port", port: Number(id.slice(1)) },
		owner: { kind: "agent", sessionId: id, cwd },
		acquiredAt: 0,
		heartbeatAt,
		ttlMs: 1000,
	});
	const audit = (d: WorktreeDeps) => auditWorktrees(d, { ...opts, roots: [fx.repo] });

	test("removes merged, keeps the branch, leaves every other state alone", async () => {
		const merged = fx.addWorktree("m");
		const dirty = fx.addWorktree("d");
		writeFileSync(join(dirty, "x"), "x");
		const d = deps();
		const { entries } = await audit(d);
		const results = await removeWorktrees(entries, d);
		expect(Object.fromEntries(results.map((r) => [r.entry.path, r.outcome]))).toEqual({
			[merged]: "removed",
			[dirty]: "skipped",
		});
		expect(existsSync(merged)).toBe(false);
		expect(existsSync(dirty)).toBe(true);
		expect(git(fx.repo, "branch", "--list", "m")).toContain("m");
	});

	test("git itself refuses a worktree that went dirty after the audit", async () => {
		const wt = fx.addWorktree("late");
		const d = deps();
		const { entries } = await audit(d);
		writeFileSync(join(wt, "late.txt"), "x");
		const [r] = await removeWorktrees(entries, d);
		expect(r?.outcome).toBe("failed");
		expect(existsSync(wt)).toBe(true);
	});

	test("refuses the worktree that holds the cwd and says where to cd", async () => {
		const wt = fx.addWorktree("here");
		const d = deps({ cwd: join(wt, "sub") });
		const { entries } = await audit(d);
		const [r] = await removeWorktrees(entries, d);
		expect(r).toMatchObject({ outcome: "refused", detail: expect.stringContaining(`cd ${fx.repo}`) });
		expect(existsSync(wt)).toBe(true);
	});

	test("stale-ref is pruned once per repo", async () => {
		const a = fx.addWorktree("a");
		const b = fx.addWorktree("b");
		rmSync(a, { recursive: true });
		rmSync(b, { recursive: true });
		const calls: string[][] = [];
		const d = deps({ exec: execWithFakes(bunExec, { lsof: "", gh: {}, calls }) });
		const { entries } = await audit(d);
		const results = await removeWorktrees(entries, d);
		expect(results.map((r) => r.outcome)).toEqual(["pruned", "pruned"]);
		expect(calls.filter((c) => c.join(" ") === "git worktree prune")).toHaveLength(1);
		expect(git(fx.repo, "worktree", "list", "--porcelain")).not.toContain(a);
	});

	test("releases the dead leases bound to the removed worktree, not other ones", async () => {
		const wt = fx.addWorktree("rel");
		const leases = [lease("p1", wt, 0), lease("p3", fx.repo, 0)];
		const deleted: string[] = [];
		const d = deps({
			leases,
			deleteLeases: (ids) => {
				deleted.push(...ids);
				return ids.length;
			},
		});
		const { entries } = await audit(d);
		const [r] = await removeWorktrees(entries, d);
		expect(r?.outcome).toBe("removed");
		expect(deleted).toEqual(["p1"]);
	});

	test("a lease that went live after the audit blocks the removal", async () => {
		const wt = fx.addWorktree("race");
		const { entries } = await audit(deps());
		const [r] = await removeWorktrees(entries, deps({ leases: [lease("p2", wt, NOW)] }));
		expect(r).toMatchObject({ outcome: "refused", detail: "live warden lease p2" });
		expect(existsSync(wt)).toBe(true);
	});
});

describe("findRecentChange", () => {
	test("sees a fresh file, ignores node_modules and .git, and an old tree is idle", async () => {
		const fx = fixtureRepo();
		try {
			const old = new Date(Date.now() - 10 * 86_400_000);
			for (const f of ["base.txt"]) utimesSync(join(fx.repo, f), old, old);
			expect(await findRecentChange(bunExec, fx.repo, 86_400_000)).toBe(false);
			writeFileSync(join(fx.repo, "new.txt"), "x");
			expect(await findRecentChange(bunExec, fx.repo, 86_400_000)).toBe(true);
		} finally {
			fx.cleanup();
		}
	});
});
