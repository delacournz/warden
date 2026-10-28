import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { execWithFakes, type Fixture, fixtureRepo } from "@delacour/warden-core/worktrees/audit.testing";
import { type TestContext, testContext } from "../testing";
import { summarizeWorktrees, worktreesCommand } from "./worktrees";

let ctx: TestContext | undefined;
let fx: Fixture | undefined;
afterEach(() => {
	ctx?.cleanup();
	fx?.cleanup();
});

function setup(argv: string[], over: Partial<TestContext> = {}): { c: TestContext; f: Fixture } {
	const f = fixtureRepo();
	fx = f;
	ctx = testContext(["--root", f.repo, "--idle", "0", "--no-fetch", ...argv], {
		exec: execWithFakes(bunExec, { lsof: "", gh: {} }),
		...over,
	});
	return { c: ctx, f };
}

const report = (c: TestContext) => JSON.parse(c.stdout.join("\n"));

describe("warden worktrees", () => {
	test("dry run reports every state, sizes them and removes nothing", async () => {
		const { c, f } = setup(["--json"]);
		const merged = f.addWorktree("done");
		const dirty = f.addWorktree("wip");
		writeFileSync(join(dirty, "x"), "x");
		expect(await worktreesCommand.run(c)).toBe(0);
		const out = report(c);
		expect(out.dryRun).toBe(true);
		expect(out.entries.map((e: { path: string; state: string }) => [e.path, e.state]).sort()).toEqual(
			[
				[merged, "merged"],
				[dirty, "review"],
			].sort()
		);
		expect(out.entries.every((e: { bytes: number }) => e.bytes > 0)).toBe(true);
		expect(out.summary).toMatchObject({ total: 2, removable: 1 });
		expect(existsSync(merged)).toBe(true);
	});

	test("--no-size leaves bytes out", async () => {
		const { c, f } = setup(["--json", "--no-size"]);
		f.addWorktree("done");
		expect(await worktreesCommand.run(c)).toBe(0);
		expect(report(c).entries[0].bytes).toBeUndefined();
	});

	test("table has the columns, the evidence and the apply hint", async () => {
		const { c, f } = setup([]);
		f.addWorktree("done");
		expect(await worktreesCommand.run(c)).toBe(0);
		const text = c.stdout.join("\n");
		for (const word of ["STATE", "SIZE", "BRANCH", "PATH", "EVIDENCE", "merged", "done", "merged into origin/main"]) {
			expect(text).toContain(word);
		}
		expect(text).toContain("warden worktrees --apply");
	});

	test("--apply removes merged worktrees only and keeps the branch", async () => {
		const { c, f } = setup(["--apply", "--json"]);
		const merged = f.addWorktree("done");
		const dirty = f.addWorktree("wip");
		writeFileSync(join(dirty, "x"), "x");
		expect(await worktreesCommand.run(c)).toBe(0);
		const out = report(c);
		expect(out.dryRun).toBe(false);
		expect(out.results.map((r: { outcome: string }) => r.outcome).sort()).toEqual(["removed", "skipped"]);
		expect(existsSync(merged)).toBe(false);
		expect(existsSync(dirty)).toBe(true);
	});

	test("--apply from inside the worktree is refused with exit 1", async () => {
		const f = fixtureRepo();
		fx = f;
		const wt = f.addWorktree("here");
		ctx = testContext(["--root", f.repo, "--idle", "0", "--no-fetch", "--apply", "--json"], {
			exec: execWithFakes(bunExec, { lsof: "", gh: {} }),
			cwd: wt,
		});
		expect(await worktreesCommand.run(ctx)).toBe(1);
		expect(existsSync(wt)).toBe(true);
	});

	test("a bad --idle is an error", async () => {
		const { c } = setup(["--idle", "soon"]);
		expect(await worktreesCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--idle");
	});

	test("nothing to audit prints a note", async () => {
		const { c } = setup([]);
		expect(await worktreesCommand.run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("no worktrees");
	});

	test("summarizeWorktrees counts without fetching and sizes the removable ones", async () => {
		const { c, f } = setup([]);
		f.addWorktree("done");
		const calls: string[][] = [];
		c.exec = execWithFakes(bunExec, { lsof: "", gh: {}, calls });
		const s = await summarizeWorktrees(c, { roots: [f.repo], idleMs: 0 });
		expect(s.summary).toMatchObject({ total: 1, removable: 1 });
		expect(s.summary.removableBytes).toBeGreaterThan(0);
		expect(calls.some((x) => x.includes("fetch"))).toBe(false);
	});
});
