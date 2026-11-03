import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import { type GitFactsCache, readGitFacts } from "../git-facts";
import type { Platform } from "../types";
import { jsInputsHash, type ReadFile, readFileOrUndefined } from "./js-inputs";

/**
 * Salt of the hashed text. Bump it whenever what the key covers changes, so an old key can only miss, never collide
 * with a new one.
 */
const KEY_FORMAT = "warden js-key v1";

/** Env var names that are bundled into the app (Expo inlines `EXPO_PUBLIC_*`) or switch the bundler's mode. */
const BUNDLE_ENV = /^(?:EXPO_PUBLIC_.*|NODE_ENV)$/;

/** Which key family: a repack over a simulator base, or a Release build that embeds its JS. Never equal for the same inputs. */
export type JsKeyKind = "simulator" | "release";

export type JsKeyDeps = {
	exec: Exec;
	readFile?: ReadFile;
	/** project root: `jsInputs` globs and `git ls-files` are relative to it */
	root: string;
	jsInputs: readonly string[];
	kind: JsKeyKind;
	platform: Platform;
	/** the native fingerprint the bundle will run in: a bundle only fits the native code it was built with */
	nativeFp: string;
	/** the process env the bundle step runs in: `EXPO_PUBLIC_*` and `NODE_ENV` of it are part of the key */
	env: Record<string, string | undefined>;
	/** `kinds.<kind>.env`: wins over `env`, and any name counts (it is configured on purpose) */
	kindEnv?: Record<string, string>;
	/** the bundler's own flags (`--minify`, `--sourcemap-output`…): another flag, another bundle */
	bundlerFlags?: readonly string[];
};

/** The env that reaches the bundle, sorted by name: `NAME=value` lines. */
function bundleEnvLines(env: Record<string, string | undefined>, kindEnv: Record<string, string> = {}): string[] {
	const merged = new Map<string, string>();
	for (const [name, value] of Object.entries(env))
		if (value !== undefined && BUNDLE_ENV.test(name)) merged.set(name, value);
	for (const [name, value] of Object.entries(kindEnv)) merged.set(name, value);
	return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => `${name}=${value}`);
}

/**
 * The content key of a JS bundle: `sha256(salt, js-inputs v2 key, sorted bundle env, bundler flags, platform, native
 * fingerprint)`, 40 hex chars. The JS half is `jsInputsHash` (git blob ids, so committing an edit changes nothing);
 * worktree path, branch and HEAD are never part of it, so two checkouts with the same JS share one repack and a branch
 * with a new commit that changed no input reuses its bundle. Errors as `jsInputsHash` does (globs matching nothing).
 */
export async function computeJsKey(deps: JsKeyDeps): AsyncResult<string> {
	const js = await jsInputsHash({
		exec: deps.exec,
		root: deps.root,
		jsInputs: deps.jsInputs,
		...(deps.readFile ? { readFile: deps.readFile } : {}),
	});
	if (!js.success) return js;
	const text = [
		`${KEY_FORMAT} ${deps.kind}`,
		`js:${js.data}`,
		`env:${bundleEnvLines(deps.env, deps.kindEnv).join("\0")}`,
		`flags:${(deps.bundlerFlags ?? []).join("\0")}`,
		`platform:${deps.platform}`,
		`native:${deps.nativeFp}`,
	].join("\n");
	return ok(createHash("sha256").update(text).digest("hex").slice(0, 40));
}

/** Where a checkout is: what a repack's `meta.json` and the `worktree` / `branch` columns record. Metadata, never a key. */
export type GitContext = {
	/** `git rev-parse --show-toplevel` of the project */
	worktree: string;
	/** absent on a detached HEAD */
	branch?: string;
	head: string;
};

/** The checkout `root` is in. Errors outside a git checkout or before the first commit. */
export async function gitContext(exec: Exec, root: string, git?: GitFactsCache): AsyncResult<GitContext> {
	const facts = await readGitFacts(exec, root, git);
	if (!facts) return err(`not a git checkout: ${root}`);
	const head = await exec(["git", "rev-parse", "HEAD"], { cwd: root });
	const sha = head.stdout.trim();
	if (head.exitCode !== 0 || sha === "") return err(`could not read HEAD of ${facts.toplevel}`);
	return ok({ worktree: facts.toplevel, ...(facts.branch !== "" ? { branch: facts.branch } : {}), head: sha });
}

/** `<repackDir>/meta.json`: who made this repack, from where, and what the bundle step cost. */
export type RepackMeta = {
	worktree: string;
	/** absent on a detached HEAD */
	branch?: string;
	head: string;
	createdAt: number;
	bundleMs: number;
};

export const REPACK_META_FILE = "meta.json";

/** Write `<dir>/meta.json` (creating `dir`). */
export function writeRepackMeta(dir: string, meta: RepackMeta): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, REPACK_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** `<dir>/meta.json`, or undefined when it is missing, unreadable or not a repack meta. */
export async function readRepackMeta(
	dir: string,
	readFile: ReadFile = readFileOrUndefined
): Promise<RepackMeta | undefined> {
	const bytes = await readFile(join(dir, REPACK_META_FILE));
	if (bytes === undefined) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
	if (!isRecord(raw)) return undefined;
	const { worktree, branch, head, createdAt, bundleMs } = raw;
	if (typeof worktree !== "string" || typeof head !== "string") return undefined;
	if (typeof createdAt !== "number" || typeof bundleMs !== "number") return undefined;
	return { worktree, ...(typeof branch === "string" ? { branch } : {}), head, createdAt, bundleMs };
}
