import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type Exec } from "../exec";
import { createGitFactsCache, readGitFacts } from "../git-facts";
import { changedFiles } from "./git";

let dir: string;

async function git(...args: string[]): Promise<void> {
	const res = await bunExec(["git", ...args], { cwd: dir });
	if (res.exitCode !== 0) throw new Error(res.stderr);
}

function write(path: string, text: string): void {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), text);
}

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-git-")));
	await git("init", "-q", "-b", "main");
	await git("config", "user.email", "t@t");
	await git("config", "user.name", "t");
	write("a.ts", "a");
	write("b.ts", "b");
	write("gone.ts", "x");
	write("old.ts", "same content long enough to be detected as a rename\n".repeat(5));
	await git("add", ".");
	await git("commit", "-qm", "base");
	await git("checkout", "-qb", "feature");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("changedFiles", () => {
	test("committed, staged, unstaged, untracked, deleted and renamed files vs the merge-base", async () => {
		write("a.ts", "a2");
		await git("commit", "-qam", "change a");
		write("b.ts", "b2");
		await git("rm", "-q", "gone.ts");
		await git("mv", "old.ts", "new.ts");
		write("src/fresh.ts", "new");
		const res = await changedFiles(bunExec, join(dir), "main");
		if (!res.success) throw new Error(res.error);
		expect(res.data.top).toBe(dir);
		const byPath = Object.fromEntries(res.data.files.map((f) => [f.path, f]));
		expect(byPath["a.ts"]?.status).toBe("modified");
		expect(byPath["b.ts"]?.status).toBe("modified");
		expect(byPath["gone.ts"]?.status).toBe("deleted");
		expect(byPath["new.ts"]).toEqual({ path: "new.ts", status: "renamed", from: "old.ts" });
		expect(byPath["src/fresh.ts"]?.status).toBe("added");
	});

	test("unknown base → error naming the ref", async () => {
		const res = await changedFiles(bunExec, dir, "nope");
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("nope");
	});
});

describe("changedFiles git spawns", () => {
	function counting() {
		const spawns: string[] = [];
		const exec: Exec = (cmd, opts) => {
			spawns.push(cmd.slice(1).join(" "));
			return bunExec(cmd, opts);
		};
		return { spawns, exec };
	}

	test("a cold cache costs one rev-parse (the facts), then merge-base, diff and ls-files", async () => {
		const { spawns, exec } = counting();
		const res = await changedFiles(exec, dir, "main", createGitFactsCache());
		if (!res.success) throw new Error(res.error);
		expect(res.data.top).toBe(dir);
		expect(spawns.map((s) => s.split(" ")[0])).toEqual(["rev-parse", "merge-base", "diff", "ls-files"]);
		expect(spawns[0]).toBe("rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD");
	});

	test("facts a caller already read are not asked for again", async () => {
		const { spawns, exec } = counting();
		const cache = createGitFactsCache();
		await readGitFacts(exec, dir, cache);
		spawns.length = 0;
		const res = await changedFiles(exec, dir, "main", cache);
		expect(res.success).toBe(true);
		expect(spawns.map((s) => s.split(" ")[0])).toEqual(["merge-base", "diff", "ls-files"]);
	});

	test("a directory inside the checkout resolves the same top, and its root is then cached", async () => {
		write("src/deep/x.ts", "x");
		const { spawns, exec } = counting();
		const cache = createGitFactsCache();
		const res = await changedFiles(exec, join(dir, "src", "deep"), "main", cache);
		if (!res.success) throw new Error(res.error);
		expect(res.data.top).toBe(dir);
		spawns.length = 0;
		await changedFiles(exec, dir, "main", cache);
		expect(spawns.some((s) => s.startsWith("rev-parse"))).toBe(false);
	});

	test("not a git checkout is an error that names the directory", async () => {
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "warden-git-plain-")));
		try {
			const res = await changedFiles(bunExec, plain, "main", createGitFactsCache());
			expect(res.success).toBe(false);
			if (!res.success) expect(res.error).toContain(plain);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
