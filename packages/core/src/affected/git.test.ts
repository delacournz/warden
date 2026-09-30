import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "../exec";
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
