import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";

/** Matched files' bytes, or undefined when unreadable (a tracked file deleted from disk). */
export type ReadFile = (path: string) => Promise<Uint8Array | undefined>;

export const readFileOrUndefined: ReadFile = async (path) => {
	try {
		return await readFile(path);
	} catch {
		return undefined;
	}
};

/** Paths (relative to the project root) matching any of `globs`, minus those matching a `!`-prefixed glob. */
export function matchJsInputs(paths: readonly string[], globs: readonly string[]): string[] {
	const include = globs.filter((g) => !g.startsWith("!")).map((g) => new Bun.Glob(g));
	const exclude = globs.filter((g) => g.startsWith("!")).map((g) => new Bun.Glob(g.slice(1)));
	return paths.filter((p) => include.some((m) => m.match(p)) && !exclude.some((m) => m.match(p)));
}

export type JsInputsDeps = {
	exec: Exec;
	readFile?: ReadFile;
	/** project root: globs and `git ls-files` are relative to it */
	root: string;
	jsInputs: readonly string[];
};

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/**
 * Salt of the hashed text. Bump it whenever the lines' meaning changes, so an old key can only
 * miss, never collide with a new one. v1 hashed `sha256(content)` of every matched file; v2 hashes
 * git blob ids.
 */
const KEY_FORMAT = "warden js-inputs v2: git blob ids";

/** Readers kept open at once when hashing the files git can't vouch for. */
const MAX_PARALLEL_READS = 32;

/** Hex length of git's object ids: 40 (SHA-1 repos) or 64 (SHA-256 repos). */
type ObjectHex = 40 | 64;

/** git's blob id of `bytes`, what `git hash-object` prints and the index records for a file with that content. */
function blobId(bytes: Uint8Array, hex: ObjectHex): string {
	return createHash(hex === 64 ? "sha256" : "sha1")
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest("hex");
}

/** `fn` over `items`, at most `limit` at once; results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

const GLOB_CHARS = /[*?[{]/;

/** A `../…` glob split at its first glob segment: list files under `dir`, match the rest against `pattern`. */
function outsideGlob(root: string, glob: string): { dir: string; pattern: string } {
	const segments = resolve(root, glob).split("/");
	const first = segments.findIndex((segment) => GLOB_CHARS.test(segment));
	if (first === -1) return { dir: dirname(segments.join("/")), pattern: segments.at(-1) ?? "" };
	return { dir: segments.slice(0, first).join("/") || "/", pattern: segments.slice(first).join("/") };
}

/**
 * The files git knows under a directory (relative to it): `path → blob id` when the index id is
 * the file's content (clean, tracked), `undefined` when the working tree has to be read (untracked,
 * modified, deleted, assume-unchanged, skip-worktree, unmerged, symlink).
 */
type Listing = { files: Map<string, string | undefined>; hex: ObjectHex };

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Modes whose index blob is the file's bytes: regular files, and gitlinks (the submodule commit; no bytes to read). */
const CONTENT_MODES: ReadonlySet<string> = new Set(["100644", "100755", "160000"]);

type IndexEntry = { tag: string; mode: string; id: string; stage: string; path: string };

/** One `git ls-files -z -v -s` entry: `<tag> <mode> <object id> <stage>\t<path>`. */
function parseIndexEntry(raw: string): IndexEntry | undefined {
	const tab = raw.indexOf("\t");
	if (tab < 0) return undefined;
	const [tag, mode, id, stage, ...rest] = raw.slice(0, tab).split(" ");
	if (!tag || !mode || !id || !stage || rest.length > 0 || !OBJECT_ID.test(id)) return undefined;
	return { tag, mode, id, stage, path: raw.slice(tab + 1) };
}

/** Whether the index blob of `entry` is the file's content: a plain cached entry (not assume-unchanged, skip-worktree, unmerged or a symlink). */
const vouches = (entry: IndexEntry) => entry.tag === "H" && entry.stage === "0" && CONTENT_MODES.has(entry.mode);

/**
 * Merge `git ls-files -z -v -s --cached --others` (tracked files with their index blob, `? path` for
 * untracked ones) with `git ls-files -z -m` (tracked files whose content differs from the index, or
 * that are gone). Only an entry that `vouches` for its content and is not modified is trusted.
 */
function parseListing(index: string, modified: string): Result<Listing> {
	const files = new Map<string, string | undefined>();
	let hex: ObjectHex = 40;
	for (const raw of index.split("\0")) {
		if (raw === "") continue;
		if (raw.startsWith("? ")) {
			files.set(raw.slice(2), undefined);
			continue;
		}
		const entry = parseIndexEntry(raw);
		if (!entry) return err(`could not read \`git ls-files\` output: ${raw.slice(0, 80)}`);
		hex = entry.id.length === 64 ? 64 : 40;
		files.set(entry.path, vouches(entry) && !files.has(entry.path) ? entry.id : undefined);
	}
	for (const path of modified.split("\0")) if (files.has(path)) files.set(path, undefined);
	return ok({ files, hex });
}

/** Tracked + untracked-not-ignored files under `dir`: the index and the modified files are listed side by side. */
async function listFiles(exec: Exec, dir: string): AsyncResult<Listing> {
	const indexArgv = ["git", "ls-files", "-z", "-v", "-s", "--cached", "--others", "--exclude-standard", "--", "."];
	const modifiedArgv = ["git", "ls-files", "-z", "-m", "--", "."];
	const [indexed, modified] = await Promise.all([exec(indexArgv, { cwd: dir }), exec(modifiedArgv, { cwd: dir })]);
	if (indexed.exitCode !== 0) return err(`could not list JS inputs: ${execError(indexArgv, indexed)}`);
	if (modified.exitCode !== 0) return err(`could not list JS inputs: ${execError(modifiedArgv, modified)}`);
	return parseListing(indexed.stdout, modified.stdout);
}

/** A matched file: its path relative to the project root, and its trusted blob id (else its working copy gets read). */
type Matched = { path: string; id: string | undefined; hex: ObjectHex };

/** Every file `globs` match: plain globs under the root, `../` globs wherever they point (each directory listed once, all at once). */
async function matchedInputs(deps: JsInputsDeps): AsyncResult<Matched[]> {
	const inside = deps.jsInputs.filter((g) => !g.startsWith("../"));
	const jobs = [
		...(inside.length > 0 ? [{ dir: deps.root, patterns: inside }] : []),
		...deps.jsInputs
			.filter((g) => g.startsWith("../"))
			.map((g) => outsideGlob(deps.root, g))
			.map(({ dir, pattern }) => ({ dir, patterns: [pattern] })),
	];
	const listings = new Map<string, AsyncResult<Listing>>();
	const listing = (dir: string) => {
		const known = listings.get(dir);
		if (known) return known;
		const started = listFiles(deps.exec, dir);
		listings.set(dir, started);
		return started;
	};
	const listed = await Promise.all(jobs.map(async (job) => ({ job, result: await listing(job.dir) })));
	const found = new Map<string, Matched>();
	for (const { job, result } of listed) {
		if (!result.success) return result;
		for (const path of matchJsInputs([...result.data.files.keys()], job.patterns)) {
			const rootRelative = relative(deps.root, join(job.dir, path));
			const seen = found.get(rootRelative);
			if (seen !== undefined && seen.id === undefined) continue;
			found.set(rootRelative, { path: rootRelative, id: result.data.files.get(path), hex: result.data.hex });
		}
	}
	return ok([...found.values()].sort((a, b) => (a.path < b.path ? -1 : 1)));
}

/**
 * Content hash of the project's JS sources: every tracked or untracked-not-ignored file that
 * matches `jsInputs`, hashed as sorted `path NUL git-blob-id` lines — so renames count and ignored
 * build output never does. A clean tracked file's blob id comes straight from git's index (no
 * read); files git can't vouch for (untracked, modified, assume-unchanged, symlinks) are read, a
 * few at a time, and hashed the way git hashes a blob, so committing an edit does not change the
 * hash. Globs are relative to the project root; a glob starting with `../` reaches outside it (a
 * workspace package the bundle embeds) and its files are keyed by their root-relative path, so the
 * hash is the same in every checkout. Errors when nothing matches (the globs are wrong; an empty
 * hash would silently never change).
 */
export async function jsInputsHash(deps: JsInputsDeps): AsyncResult<string> {
	const matched = await matchedInputs(deps);
	if (!matched.success) return matched;
	const read = deps.readFile ?? readFileOrUndefined;
	const hashed = await mapLimit(matched.data, MAX_PARALLEL_READS, async (file) => {
		if (file.id !== undefined) return `${file.path}\0${file.id}`;
		const bytes = await read(join(deps.root, file.path));
		return bytes === undefined ? undefined : `${file.path}\0${blobId(bytes, file.hex)}`;
	});
	const lines = hashed.filter((line): line is string => line !== undefined);
	if (lines.length === 0) {
		return err(`fingerprint.jsInputs (${deps.jsInputs.join(", ")}) matched no files under ${deps.root}`);
	}
	return ok(sha256(`${KEY_FORMAT}\n${lines.join("\n")}`));
}

/** The cache / install key of a JS-aware project: 40 hex chars like an `@expo/fingerprint` hash. */
export function combineKey(native: string, js: string): string {
	return sha256(`native:${native}\njs:${js}`).slice(0, 40);
}
