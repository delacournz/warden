import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "../exec";
import { createGitFactsCache } from "../git-facts";
import { DEFAULT_JS_INPUTS } from "./builds.defaults";
import {
	computeJsKey,
	gitContext,
	type JsKeyDeps,
	REPACK_META_FILE,
	type RepackMeta,
	readRepackMeta,
	writeRepackMeta,
} from "./js-key";

let dir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const res = await bunExec(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
	if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
	return res.stdout.trim();
}

function write(root: string, files: Record<string, string>): void {
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), body);
	}
}

async function repo(name: string, files: Record<string, string>): Promise<string> {
	const root = join(dir, name);
	mkdirSync(root, { recursive: true });
	await git(root, "init", "-q", "-b", "main");
	write(root, files);
	await git(root, "add", "-A");
	await git(root, "commit", "-q", "-m", "init");
	return root;
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-jskey-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const APP = { "src/a.ts": "a", "app.json": "{}", "ios/Podfile": "pods", "android/build.gradle": "g" };

const deps = (root: string, over: Partial<JsKeyDeps> = {}): JsKeyDeps => ({
	exec: bunExec,
	root,
	jsInputs: DEFAULT_JS_INPUTS,
	kind: "simulator",
	platform: "ios",
	nativeFp: "fp1",
	env: {},
	...over,
});

const key = async (d: JsKeyDeps): Promise<string> => {
	const res = await computeJsKey(d);
	if (!res.success) throw new Error(res.error);
	return res.data;
};

describe("computeJsKey", () => {
	test("40 hex chars, stable for the same inputs", async () => {
		const root = await repo("a", APP);
		const first = await key(deps(root));
		expect(first).toMatch(/^[0-9a-f]{40}$/);
		expect(await key(deps(root))).toBe(first);
	});

	test("content, not location: two checkouts of the same JS share a key", async () => {
		const a = await repo("a", APP);
		const b = await repo("b", APP);
		expect(await key(deps(a))).toBe(await key(deps(b)));
	});

	test("committing an edit changes nothing; editing a JS input does", async () => {
		const root = await repo("a", APP);
		const before = await key(deps(root));
		write(root, { "src/a.ts": "changed" });
		const dirty = await key(deps(root));
		expect(dirty).not.toBe(before);
		await git(root, "commit", "-q", "-am", "edit");
		expect(await key(deps(root))).toBe(dirty);
	});

	test("native directories are not JS inputs by default", async () => {
		const root = await repo("a", APP);
		const before = await key(deps(root));
		write(root, { "ios/Podfile": "other pods", "android/build.gradle": "other" });
		expect(await key(deps(root))).toBe(before);
	});

	test("the native fingerprint, platform and kind are part of the key", async () => {
		const root = await repo("a", APP);
		const base = await key(deps(root));
		expect(await key(deps(root, { nativeFp: "fp2" }))).not.toBe(base);
		expect(await key(deps(root, { platform: "android" }))).not.toBe(base);
		expect(await key(deps(root, { kind: "release" }))).not.toBe(base);
	});

	test("EXPO_PUBLIC_* and NODE_ENV of the process env count, other env does not", async () => {
		const root = await repo("a", APP);
		const base = await key(deps(root));
		expect(await key(deps(root, { env: { EXPO_PUBLIC_API: "https://x" } }))).not.toBe(base);
		expect(await key(deps(root, { env: { NODE_ENV: "production" } }))).not.toBe(base);
		expect(await key(deps(root, { env: { HOME: "/h", PATH: "/bin", EXPO_TOKEN: "t" } }))).toBe(base);
	});

	test("env order does not matter; kind env overrides and adds", async () => {
		const root = await repo("a", APP);
		const ab = await key(deps(root, { env: { EXPO_PUBLIC_A: "1", EXPO_PUBLIC_B: "2" } }));
		const ba = await key(deps(root, { env: { EXPO_PUBLIC_B: "2", EXPO_PUBLIC_A: "1" } }));
		expect(ab).toBe(ba);
		const overridden = await key(deps(root, { env: { EXPO_PUBLIC_A: "0" }, kindEnv: { EXPO_PUBLIC_A: "1" } }));
		expect(overridden).toBe(await key(deps(root, { env: { EXPO_PUBLIC_A: "1" } })));
		expect(await key(deps(root, { kindEnv: { ANY_NAME: "x" } }))).not.toBe(await key(deps(root)));
	});

	test("bundler flags are part of the key", async () => {
		const root = await repo("a", APP);
		expect(await key(deps(root, { bundlerFlags: ["--minify"] }))).not.toBe(await key(deps(root)));
	});

	test("globs that match nothing are an error, not an empty key", async () => {
		const root = await repo("a", APP);
		const res = await computeJsKey(deps(root, { jsInputs: ["nothing/**"] }));
		expect(res.success).toBe(false);
	});
});

describe("gitContext", () => {
	test("worktree, branch and head", async () => {
		const root = await repo("a", APP);
		const head = await git(root, "rev-parse", "HEAD");
		const ctx = await gitContext(bunExec, root, createGitFactsCache());
		expect(ctx).toEqual({ success: true, data: { worktree: root, branch: "main", head } });
	});

	test("a subdirectory reports the checkout's toplevel", async () => {
		const root = await repo("a", APP);
		const ctx = await gitContext(bunExec, join(root, "src"), createGitFactsCache());
		expect(ctx.success && ctx.data.worktree).toBe(root);
	});

	test("a detached HEAD has no branch", async () => {
		const root = await repo("a", APP);
		await git(root, "checkout", "-q", "--detach");
		const ctx = await gitContext(bunExec, root, createGitFactsCache());
		expect(ctx.success && "branch" in ctx.data).toBe(false);
	});

	test("outside a checkout is an error", async () => {
		const plain = join(dir, "plain");
		mkdirSync(plain);
		const ctx = await gitContext(bunExec, plain, createGitFactsCache());
		expect(ctx.success).toBe(false);
	});
});

describe("repack meta", () => {
	const meta: RepackMeta = { worktree: "/w/a", branch: "feat/x", head: "abc", createdAt: 5, bundleMs: 1234 };

	test("write then read round-trips, creating the dir", async () => {
		const target = join(dir, "repacks", "js1");
		writeRepackMeta(target, meta);
		expect(await readRepackMeta(target)).toEqual(meta);
	});

	test("a missing branch stays missing", async () => {
		const { branch: _branch, ...detached } = meta;
		writeRepackMeta(dir, detached);
		expect(await readRepackMeta(dir)).toEqual(detached);
	});

	test("missing, malformed or foreign files read as undefined", async () => {
		expect(await readRepackMeta(join(dir, "none"))).toBeUndefined();
		writeFileSync(join(dir, REPACK_META_FILE), "{not json");
		expect(await readRepackMeta(dir)).toBeUndefined();
		writeFileSync(join(dir, REPACK_META_FILE), JSON.stringify({ worktree: 1 }));
		expect(await readRepackMeta(dir)).toBeUndefined();
	});

	test("reads through an injected readFile", async () => {
		const read = async () => new TextEncoder().encode(JSON.stringify(meta));
		expect(await readRepackMeta("/anywhere", read)).toEqual(meta);
	});
});
