import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bunExec, type Exec } from "../exec";
import { combineKey, jsInputsHash, matchJsInputs, type ReadFile, readFileOrUndefined } from "./js-inputs";

const INDEX_ARGV = "git ls-files -z -v -s --cached --others --exclude-standard -- .";
const MODIFIED_ARGV = "git ls-files -z -m -- .";

/** git's blob id of `text`: what the index records for a file with that content. */
const blob = (text: string) =>
	createHash("sha1")
		.update(`blob ${Buffer.byteLength(text)}\0${text}`)
		.digest("hex");

type Tree = Record<string, string>;

/**
 * A fake `git` over an index (`path → committed content`) and a working tree (`path → content on
 * disk`, defaults to the index): `-s` lists every indexed file as a clean `H` entry plus the
 * untracked ones as `? path`, `-m` the indexed files whose disk content differs or is gone.
 */
function host(index: Tree, work: Tree = index) {
	const calls: Array<{ cmd: string; cwd?: string }> = [];
	const reads: string[] = [];
	const exec: Exec = async (cmd, opts) => {
		const line = cmd.join(" ");
		calls.push({ cmd: line, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
		if (line === INDEX_ARGV) {
			const tracked = Object.entries(index).map(([path, text]) => `H 100644 ${blob(text)} 0\t${path}`);
			const untracked = Object.keys(work)
				.filter((path) => !(path in index))
				.map((path) => `? ${path}`);
			return { exitCode: 0, stdout: [...tracked, ...untracked].join("\0"), stderr: "" };
		}
		if (line === MODIFIED_ARGV) {
			const modified = Object.keys(index).filter((path) => work[path] !== index[path]);
			return { exitCode: 0, stdout: modified.join("\0"), stderr: "" };
		}
		return { exitCode: 2, stdout: "", stderr: `unexpected ${line}` };
	};
	const readFile: ReadFile = async (path) => {
		reads.push(path);
		const body = work[path.replace("/repo/app/", "")];
		return body === undefined ? undefined : new TextEncoder().encode(body);
	};
	return { exec, readFile, calls, reads };
}

type Host = ReturnType<typeof host>;

describe("matchJsInputs", () => {
	test("globs relative to the project root", () => {
		const paths = ["src/a.ts", "src/deep/b.tsx", "app.json", "ios/Podfile", "README.md"];
		expect(matchJsInputs(paths, ["src/**", "app.json"])).toEqual(["src/a.ts", "src/deep/b.tsx", "app.json"]);
	});

	test("a `!` glob excludes what the others matched", () => {
		const paths = ["src/a.ts", "ios/Podfile", "android/app/build.gradle", "node_modules/x/i.js", "app.json"];
		expect(matchJsInputs(paths, ["**", "!ios/**", "!android/**", "!node_modules/**"])).toEqual([
			"src/a.ts",
			"app.json",
		]);
	});

	test("only `!` globs match nothing", () => {
		expect(matchJsInputs(["src/a.ts"], ["!src/**"])).toEqual([]);
	});
});

describe("jsInputsHash", () => {
	const inputs = ["src/**"];
	const run = (h: Host, jsInputs: readonly string[] = inputs) =>
		jsInputsHash({ exec: h.exec, readFile: h.readFile, root: "/repo/app", jsInputs });
	const hash = async (h: Host, jsInputs: readonly string[] = inputs) => {
		const res = await run(h, jsInputs);
		if (!res.success) throw new Error(res.error);
		return res.data;
	};

	test("one git call lists the index with blob ids and untracked files, another the modified ones", async () => {
		const h = host({ "src/a.ts": "a" });
		await run(h);
		expect(h.calls.map((c) => c.cmd).sort()).toEqual([INDEX_ARGV, MODIFIED_ARGV].sort());
		expect(h.calls.every((c) => c.cwd === "/repo/app")).toBe(true);
	});

	test("the two git calls run side by side", async () => {
		const started: string[] = [];
		const gate = Promise.withResolvers<void>();
		const exec: Exec = async (cmd) => {
			started.push(cmd.join(" "));
			await gate.promise;
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const pending = jsInputsHash({ exec, root: "/repo/app", jsInputs: inputs });
		await Bun.sleep(0);
		expect(started.sort()).toEqual([INDEX_ARGV, MODIFIED_ARGV].sort());
		gate.resolve();
		await pending;
	});

	test("clean tracked files are never read: their blob id from the index is the content hash", async () => {
		const h = host({ "src/a.ts": "a", "src/b.ts": "b" });
		await hash(h);
		expect(h.reads).toEqual([]);
	});

	test("only dirty, untracked and deleted files are read", async () => {
		const h = host(
			{ "src/a.ts": "a", "src/dirty.ts": "old", "src/gone.ts": "g" },
			{ "src/a.ts": "a", "src/dirty.ts": "new", "src/fresh.ts": "f" }
		);
		await hash(h);
		expect(h.reads.sort()).toEqual(["/repo/app/src/dirty.ts", "/repo/app/src/fresh.ts", "/repo/app/src/gone.ts"]);
	});

	test("same content → same hash; any matched file change → new hash; order irrelevant", async () => {
		const a = host({ "src/a.ts": "a", "src/b.ts": "b" });
		const b = host({ "src/b.ts": "b", "src/a.ts": "a" });
		const edited = host({ "src/a.ts": "a", "src/b.ts": "b" }, { "src/a.ts": "a", "src/b.ts": "CHANGED" });
		const committed = host({ "src/a.ts": "a", "src/b.ts": "CHANGED" });
		expect(await hash(a)).toBe(await hash(b));
		expect(await hash(a)).not.toBe(await hash(edited));
		expect(await hash(edited)).toBe(await hash(committed));
	});

	test("an untracked file moves the hash, a file outside the globs doesn't", async () => {
		const base = host({ "src/a.ts": "a", "docs/x.md": "1" });
		const added = host({ "src/a.ts": "a", "docs/x.md": "1" }, { "src/a.ts": "a", "docs/x.md": "1", "src/new.ts": "n" });
		const docs = host({ "src/a.ts": "a", "docs/x.md": "1" }, { "src/a.ts": "a", "docs/x.md": "2" });
		expect(await hash(added)).not.toBe(await hash(base));
		expect(await hash(docs)).toBe(await hash(base));
	});

	test("renaming a file changes the hash even with equal content", async () => {
		expect(await hash(host({ "src/a.ts": "x" }))).not.toBe(await hash(host({ "src/b.ts": "x" })));
	});

	test("a tracked file deleted from disk is skipped, not an error", async () => {
		const gone = host({ "src/a.ts": "a", "src/gone.ts": "g" }, { "src/a.ts": "a" });
		expect(await hash(gone)).toBe(await hash(host({ "src/a.ts": "a" })));
	});

	test("no file matches → error (the globs are wrong, not an empty hash)", async () => {
		const res = await run(host({ "ios/Podfile": "p" }));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("fingerprint.jsInputs");
	});

	test("git failure → error", async () => {
		const exec: Exec = async () => ({ exitCode: 128, stdout: "", stderr: "not a git repository" });
		const res = await jsInputsHash({ exec, readFile: async () => undefined, root: "/repo/app", jsInputs: inputs });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("not a git repository");
	});

	test("an index entry it cannot parse is an error, not a silently skipped file", async () => {
		const exec: Exec = async (cmd) => ({
			exitCode: 0,
			stdout: cmd.join(" ") === INDEX_ARGV ? "surprise format" : "",
			stderr: "",
		});
		const res = await jsInputsHash({ exec, root: "/repo/app", jsInputs: inputs });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("surprise format");
	});

	test("the key format is new: never equal to the legacy sha256-of-content hash (a one-time cache miss, no false hit)", async () => {
		const h = host({ "src/a.ts": "a" });
		const legacy = createHash("sha256")
			.update(`src/a.ts\0${createHash("sha256").update("a").digest("hex")}`)
			.digest("hex");
		expect(await hash(h)).not.toBe(legacy);
	});

	describe("entries git can't vouch for are read from disk", () => {
		/** a one-file index whose only `src/a.ts` line is `tag mode`, working copy `disk` */
		const withEntry = (line: string, disk: string) => {
			const reads: string[] = [];
			const exec: Exec = async (cmd) => ({
				exitCode: 0,
				stdout: cmd.join(" ") === INDEX_ARGV ? `${line}\tsrc/a.ts` : "",
				stderr: "",
			});
			const readFile: ReadFile = async (path) => {
				reads.push(path);
				return new TextEncoder().encode(disk);
			};
			return { exec, readFile, reads };
		};
		const id = blob("indexed");
		const cases: Array<[string, string]> = [
			["assume-unchanged (h)", `h 100644 ${id} 0`],
			["skip-worktree (S)", `S 100644 ${id} 0`],
			["unmerged (M, stage 2)", `M 100644 ${id} 2`],
			["a symlink (follows its target)", `H 120000 ${id} 0`],
		];
		for (const [name, line] of cases) {
			test(name, async () => {
				const h = withEntry(line, "on disk");
				const res = await jsInputsHash({ exec: h.exec, readFile: h.readFile, root: "/repo/app", jsInputs: inputs });
				expect(res.success).toBe(true);
				expect(h.reads).toEqual(["/repo/app/src/a.ts"]);
			});
		}

		test("a plain executable file is trusted", async () => {
			const h = withEntry(`H 100755 ${id} 0`, "on disk");
			await jsInputsHash({ exec: h.exec, readFile: h.readFile, root: "/repo/app", jsInputs: inputs });
			expect(h.reads).toEqual([]);
		});

		test("a SHA-256 repo: dirty content is hashed as a 64-hex blob id", async () => {
			const sha256Id = createHash("sha256").update("blob 3\0new").digest("hex");
			const exec: Exec = async (cmd) => ({
				exitCode: 0,
				stdout:
					cmd.join(" ") === INDEX_ARGV
						? `H 100644 ${createHash("sha256").update("blob 3\0old").digest("hex")} 0\tsrc/a.ts`
						: "src/a.ts",
				stderr: "",
			});
			const dirty = await jsInputsHash({
				exec,
				readFile: async () => new TextEncoder().encode("new"),
				root: "/repo/app",
				jsInputs: inputs,
			});
			const committedExec: Exec = async (cmd) => ({
				exitCode: 0,
				stdout: cmd.join(" ") === INDEX_ARGV ? `H 100644 ${sha256Id} 0\tsrc/a.ts` : "",
				stderr: "",
			});
			const committed = await jsInputsHash({ exec: committedExec, root: "/repo/app", jsInputs: inputs });
			expect(dirty).toEqual(committed);
		});
	});

	test("reads of untracked files are bounded", async () => {
		const files: Tree = {};
		for (let i = 0; i < 100; i++) files[`src/f${i}.ts`] = String(i);
		const h = host({}, files);
		let inFlight = 0;
		let peak = 0;
		const readFile: ReadFile = async (path) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Bun.sleep(1);
			inFlight--;
			return h.readFile(path);
		};
		const res = await jsInputsHash({ exec: h.exec, readFile, root: "/repo/app", jsInputs: inputs });
		expect(res.success).toBe(true);
		expect(h.reads).toHaveLength(100);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(32);
	});
});

describe("combineKey", () => {
	test("deterministic, depends on both halves, hex of the native hash's length class", () => {
		const k = combineKey("native1", "js1");
		expect(k).toBe(combineKey("native1", "js1"));
		expect(k).not.toBe(combineKey("native2", "js1"));
		expect(k).not.toBe(combineKey("native1", "js2"));
		expect(k).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("jsInputsHash with ../ globs", () => {
	/** two git dirs: the project and a workspace package beside it; `ls-files` answers per cwd */
	function twoDirs(engine: Tree, app: Tree = { "src/a.ts": "a" }) {
		const calls: string[] = [];
		const treeOf = (cwd: string | undefined) =>
			cwd === "/repo/app" ? app : cwd === "/repo/packages/engine/src" ? engine : undefined;
		const exec: Exec = async (cmd, opts) => {
			calls.push(`${cmd.join(" ") === INDEX_ARGV ? "index" : "modified"} ${opts?.cwd ?? ""}`);
			const files = treeOf(opts?.cwd);
			if (!files) return { exitCode: 128, stdout: "", stderr: "not a git repo" };
			if (cmd.join(" ") === MODIFIED_ARGV) return { exitCode: 0, stdout: "", stderr: "" };
			return {
				exitCode: 0,
				stdout: Object.entries(files)
					.map(([path, text]) => `H 100644 ${blob(text)} 0\t${path}`)
					.join("\0"),
				stderr: "",
			};
		};
		return { exec, calls };
	}
	const globs = ["src/**", "../packages/engine/src/**"];
	const run = (h: ReturnType<typeof twoDirs>, jsInputs: readonly string[] = globs) =>
		jsInputsHash({ exec: h.exec, root: "/repo/app", jsInputs });

	test("files outside the root are listed from where they live and move the hash", async () => {
		const a = twoDirs({ "x.ts": "1" });
		const b = twoDirs({ "x.ts": "2" });
		const ra = await run(a);
		expect(ra.success).toBe(true);
		expect(a.calls.sort()).toEqual([
			"index /repo/app",
			"index /repo/packages/engine/src",
			"modified /repo/app",
			"modified /repo/packages/engine/src",
		]);
		expect(await run(a)).toEqual(ra);
		expect(await run(b)).not.toEqual(ra);
	});

	test("the project and the outside directory are listed side by side", async () => {
		const started: string[] = [];
		const gate = Promise.withResolvers<void>();
		const exec: Exec = async (_cmd, opts) => {
			started.push(opts?.cwd ?? "");
			await gate.promise;
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const pending = jsInputsHash({ exec, root: "/repo/app", jsInputs: globs });
		await Bun.sleep(0);
		expect(new Set(started)).toEqual(new Set(["/repo/app", "/repo/packages/engine/src"]));
		gate.resolve();
		await pending;
	});

	test("two globs into one outside directory list it once", async () => {
		const h = twoDirs({ "x.ts": "1" });
		await run(h, ["../packages/engine/src/**/*.ts", "../packages/engine/src/**/*.tsx"]);
		expect(h.calls.sort()).toEqual(["index /repo/packages/engine/src", "modified /repo/packages/engine/src"]);
	});

	test("only ../ globs: the project root isn't listed at all", async () => {
		const h = twoDirs({ "x.ts": "1" });
		const res = await run(h, ["../packages/engine/src/**"]);
		expect(res.success).toBe(true);
		expect(h.calls.sort()).toEqual(["index /repo/packages/engine/src", "modified /repo/packages/engine/src"]);
	});

	test("a ../ glob into a directory git can't list is an error", async () => {
		const h = twoDirs({ "x.ts": "1" });
		const res = await run(h, ["../nope/**"]);
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("could not list JS inputs");
		expect(h.calls.every((c) => c.endsWith("/repo/nope"))).toBe(true);
	});
});

describe("jsInputsHash on a real git repo", () => {
	const dirs: string[] = [];
	const git = async (cwd: string, ...args: string[]): Promise<void> => {
		const res = await bunExec(["git", ...args], { cwd });
		if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
	};
	const write = (root: string, path: string, text: string): void => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	/** a committed project: sources, a lockfile, docs and an ignored build dir */
	async function repo(layout: Tree = {}): Promise<string> {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-js-inputs-")));
		dirs.push(dir);
		await git(dir, "init", "-q", "-b", "main");
		await git(dir, "config", "user.email", "t@t");
		await git(dir, "config", "user.name", "t");
		await git(dir, "config", "commit.gpgsign", "false");
		const files: Tree = {
			"src/a.ts": "a",
			"src/b.ts": "b",
			"bun.lock": "lock 1",
			"docs/x.md": "docs",
			".gitignore": "dist/\n",
			...layout,
		};
		for (const [path, text] of Object.entries(files)) write(dir, path, text);
		await git(dir, "add", ".");
		await git(dir, "commit", "-qm", "base");
		return dir;
	}
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const reads: string[] = [];
	beforeEach(() => {
		reads.length = 0;
	});
	const spy: ReadFile = async (path) => {
		reads.push(path);
		return readFileOrUndefined(path);
	};
	const hashOf = async (root: string, jsInputs: readonly string[] = ["src/**"]): Promise<string> => {
		const res = await jsInputsHash({ exec: bunExec, readFile: spy, root, jsInputs });
		if (!res.success) throw new Error(res.error);
		return res.data;
	};

	test("the same tree in two checkouts hashes equally and a clean tree reads no file", async () => {
		const [one, two] = [await repo(), await repo()];
		expect(await hashOf(one)).toBe(await hashOf(two));
		expect(reads).toEqual([]);
	});

	test("an edit changes the hash and only that file is read", async () => {
		const dir = await repo();
		const before = await hashOf(dir);
		write(dir, "src/a.ts", "edited");
		expect(await hashOf(dir)).not.toBe(before);
		expect(reads).toEqual([join(dir, "src/a.ts")]);
	});

	test("staging or committing an edit keeps the hash: the key survives a commit", async () => {
		const dir = await repo();
		write(dir, "src/a.ts", "edited");
		const dirty = await hashOf(dir);
		await git(dir, "add", "src/a.ts");
		expect(await hashOf(dir)).toBe(dirty);
		await git(dir, "commit", "-qm", "edit");
		expect(await hashOf(dir)).toBe(dirty);
	});

	test("an untracked file under the globs changes the hash; ignored output and files outside the globs don't", async () => {
		const dir = await repo();
		const before = await hashOf(dir);
		write(dir, "dist/bundle.js", "ignored");
		write(dir, "docs/y.md", "outside");
		write(dir, "docs/x.md", "docs edited");
		expect(await hashOf(dir)).toBe(before);
		write(dir, "src/new.ts", "new");
		expect(await hashOf(dir)).not.toBe(before);
	});

	test("a file deleted from disk is skipped, the same as a committed deletion", async () => {
		const dir = await repo();
		await Bun.file(join(dir, "src/b.ts")).delete();
		const unstaged = await hashOf(dir);
		await git(dir, "rm", "-q", "src/b.ts");
		await git(dir, "commit", "-qm", "rm");
		expect(await hashOf(dir)).toBe(unstaged);
	});

	test("a lockfile in jsInputs moves the hash; left out of the globs it doesn't", async () => {
		const dir = await repo();
		const withLock = ["src/**", "bun.lock"];
		const [lockBefore, srcBefore] = [await hashOf(dir, withLock), await hashOf(dir)];
		write(dir, "bun.lock", "lock 2");
		expect(await hashOf(dir, withLock)).not.toBe(lockBefore);
		expect(await hashOf(dir)).toBe(srcBefore);
	});

	test("renaming a file moves the hash", async () => {
		const dir = await repo();
		const before = await hashOf(dir);
		await git(dir, "mv", "src/a.ts", "src/c.ts");
		expect(await hashOf(dir)).not.toBe(before);
	});

	test("an edit to an assume-unchanged file is still seen", async () => {
		const dir = await repo();
		const before = await hashOf(dir);
		await git(dir, "update-index", "--assume-unchanged", "src/a.ts");
		write(dir, "src/a.ts", "edited behind git's back");
		expect(await hashOf(dir)).not.toBe(before);
	});

	test("a symlink hashes its target's content, even a target outside the globs", async () => {
		const dir = await repo({ "shared/lib.ts": "v1" });
		symlinkSync("../shared/lib.ts", join(dir, "src/lib.ts"));
		await git(dir, "add", ".");
		await git(dir, "commit", "-qm", "link");
		const before = await hashOf(dir);
		write(dir, "shared/lib.ts", "v2");
		expect(await hashOf(dir)).not.toBe(before);
	});

	test("../ globs are listed from the directory they point at", async () => {
		const dir = await repo({ "app/src/a.ts": "a", "packages/engine/src/x.ts": "1" });
		const root = join(dir, "app");
		const globs = ["src/**", "../packages/engine/src/**"];
		const before = await hashOf(root, globs);
		write(dir, "packages/engine/src/x.ts", "2");
		expect(await hashOf(root, globs)).not.toBe(before);
		expect(reads).toEqual([join(dir, "packages/engine/src/x.ts")]);
	});

	test("no file matches → error; not a git repository → error", async () => {
		const dir = await repo();
		const none = await jsInputsHash({ exec: bunExec, root: dir, jsInputs: ["nothing/**"] });
		expect(none.success).toBe(false);
		if (!none.success) expect(none.error).toContain("matched no files");
		const bare = realpathSync(mkdtempSync(join(tmpdir(), "warden-not-git-")));
		dirs.push(bare);
		const res = await jsInputsHash({ exec: bunExec, root: bare, jsInputs: ["src/**"] });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("could not list JS inputs");
	});
});
