import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { Exec } from "../exec";

/** What the graph walker is asked: one platform's imports reachable from `entries`. */
export const graphRequestSchema = z.object({
	platform: z.enum(["ios", "android"]),
	repoRoot: z.string(),
	fallbackTsconfig: z.string().optional(),
	/** where the walk starts: every flow's entries and the router layouts above them (absolute) */
	entries: z.array(z.string()),
	/** the specifier cache (`openImportCache(path)`) the walk reads and updates */
	importCachePath: z.string().optional(),
});
export type GraphRequest = z.infer<typeof graphRequestSchema>;

/** Bump when the walker resolves differently or this format changes: every snapshot made before misses. */
export const GRAPH_VERSION = 1;

/**
 * The imports of every file reachable from the request's entries, as one flat table: `edges[i]`
 * are the files `files[i]` imports, as indexes into `files`, in import order (the order decides
 * which chain `chainTo` reports).
 */
export type GraphDoc = { version: typeof GRAPH_VERSION; files: string[]; edges: number[][] };

/** `reached` (the files a walk found) and what each imports → the table. */
export function graphDoc(reached: Iterable<string>, imports: (file: string) => string[]): GraphDoc {
	const files = [...reached];
	const index = new Map(files.map((file, i) => [file, i]));
	const edges = files.map((file) =>
		imports(file).flatMap((target) => {
			const at = index.get(target);
			return at === undefined ? [] : [at];
		})
	);
	return { version: GRAPH_VERSION, files, edges };
}

/** `imports` over a table; a file the walk never reached has none. */
export function importsOfDoc(doc: GraphDoc): (file: string) => string[] {
	const index = new Map(doc.files.map((file, i) => [file, i]));
	return (file) => {
		const at = index.get(file);
		const targets = at === undefined ? [] : (doc.edges[at] ?? []);
		return targets.flatMap((i) => doc.files[i] ?? []);
	};
}

/** A table from text; anything that is not exactly the format (an old version, a torn write, a hand edit) is `undefined`. */
export function parseGraphDoc(text: string): GraphDoc | undefined {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof json !== "object" || json === null) return undefined;
	const { version, files, edges } = json as Record<string, unknown>;
	if (version !== GRAPH_VERSION || !Array.isArray(files) || !Array.isArray(edges)) return undefined;
	if (files.length !== edges.length || !files.every((f) => typeof f === "string")) return undefined;
	const inRange = (i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < files.length;
	if (!edges.every((list) => Array.isArray(list) && list.every(inRange))) return undefined;
	return { version: GRAPH_VERSION, files: files as string[], edges: edges as number[][] };
}

/** Dirty files up to this size are hashed by content, larger ones by size + mtime. */
const HASH_CONTENT_MAX = 256 * 1024;
/** More dirty files than this and the state is not worth keying (a miss is just a rebuild). */
const MAX_DIRTY = 2_000;

/** Paths of a `git status --porcelain -z` listing (a rename lists its old path too). */
export function statusPaths(out: string): string[] {
	const records = out.split("\0").filter((r) => r.length > 0);
	const paths: string[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i] as string;
		paths.push(record.slice(3));
		if (/^[RC]/.test(record) || /^.[RC]/.test(record)) {
			i++;
			const from = records[i];
			if (from !== undefined) paths.push(from);
		}
	}
	return paths;
}

/** What identifies a file's current state without keeping it: `gone`, or a content hash, or size + mtime for a big one. */
function fileState(path: string): string {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return `${stat.mode}:${stat.mtimeMs}`;
		if (stat.size > HASH_CONTENT_MAX) return `${stat.size}:${stat.mtimeMs}`;
		return createHash("sha1").update(readFileSync(path)).digest("hex");
	} catch {
		return "gone";
	}
}

/** The `node_modules` dirs a walk resolves through, and their `@scope` dirs: a package added or linked changes one's mtime. */
function moduleDirStates(roots: readonly string[]): string[] {
	const states: string[] = [];
	for (const root of new Set(roots)) {
		const dir = join(root, "node_modules");
		try {
			states.push(`${dir}:${statSync(dir).mtimeMs}`);
			for (const name of readdirSync(dir)) {
				if (name.startsWith("@")) states.push(`${dir}/${name}:${statSync(join(dir, name)).mtimeMs}`);
			}
		} catch {
			states.push(`${dir}:none`);
		}
	}
	return states;
}

/**
 * `<HEAD>-<hash>` for the repo as it is now and the request, or `undefined` when it cannot be keyed
 * (not a git repo, no commit yet, too many dirty files). The hash covers the request, the walker's
 * version, every dirty or untracked file's content (git status lists them; ignored files are not
 * source) and the `node_modules` dirs, so any source change, any tsconfig change and any package
 * install misses. Files under `ignoreDir` (the cache itself) do not count.
 */
export async function snapshotKey(exec: Exec, request: GraphRequest, ignoreDir?: string): Promise<string | undefined> {
	const cwd = request.repoRoot;
	const [head, status] = await Promise.all([
		exec(["git", "rev-parse", "--show-toplevel", "HEAD"], { cwd }),
		exec(["git", "status", "--porcelain", "-z", "--untracked-files=all"], { cwd }),
	]);
	if (head.exitCode !== 0 || status.exitCode !== 0) return undefined;
	const [top, sha] = head.stdout.trim().split("\n");
	if (top === undefined || sha === undefined || !/^[0-9a-f]{40,64}$/.test(sha)) return undefined;
	const dirty = statusPaths(status.stdout)
		.map((path) => join(top, path))
		.filter((path) => {
			if (ignoreDir === undefined) return true;
			const rel = relative(ignoreDir, path);
			return rel.startsWith("..") || isAbsolute(rel);
		})
		.sort();
	if (dirty.length > MAX_DIRTY) return undefined;
	const hash = createHash("sha1");
	hash.update(
		JSON.stringify([
			GRAPH_VERSION,
			request.platform,
			request.repoRoot,
			request.fallbackTsconfig ?? null,
			request.entries,
		])
	);
	for (const path of dirty) hash.update(`\0${path}\0${fileState(path)}`);
	hash.update(`\0${moduleDirStates([request.repoRoot, top]).join("\0")}`);
	return `${sha}-${hash.digest("hex").slice(0, 16)}`;
}

const SNAPSHOT_FILE = /^[0-9a-f]{40,64}-[0-9a-f]{16}\.json$/;
/** How many snapshots a cache dir keeps (newest first): every edit of a dirty tree makes a new one. */
const KEEP_SNAPSHOTS = 24;

/** The snapshot for `key` under `dir`, or `undefined` (none, or not a valid table). */
export function readSnapshot(dir: string, key: string): GraphDoc | undefined {
	try {
		return parseGraphDoc(readFileSync(join(dir, `${key}.json`), "utf8"));
	} catch {
		return undefined;
	}
}

/** Write the snapshot (a partial file is never visible) and drop all but the newest `KEEP_SNAPSHOTS`. Best effort: a cache that cannot be written is only a miss next time. */
export function writeSnapshot(dir: string, key: string, doc: GraphDoc): void {
	try {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `${key}.json`);
		const partial = `${file}.${process.pid}.tmp`;
		writeFileSync(partial, JSON.stringify(doc));
		renameSync(partial, file);
		const snapshots = readdirSync(dir)
			.filter((name) => SNAPSHOT_FILE.test(name))
			.map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
			.sort((a, b) => b.at - a.at);
		for (const old of snapshots.slice(KEEP_SNAPSHOTS)) rmSync(join(dir, old.name), { force: true });
	} catch {
		// read-only or full disk: the next run builds the graph again
	}
}
