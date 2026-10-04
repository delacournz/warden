import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
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

/** Paths (relative to the project root) matching any of `globs`. */
export function matchJsInputs(paths: readonly string[], globs: readonly string[]): string[] {
	const matchers = globs.map((g) => new Bun.Glob(g));
	return paths.filter((p) => matchers.some((m) => m.match(p)));
}

export type JsInputsDeps = {
	exec: Exec;
	readFile?: ReadFile;
	/** project root: globs and `git ls-files` are relative to it */
	root: string;
	jsInputs: readonly string[];
};

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

const GLOB_CHARS = /[*?[{]/;

/** A `../…` glob split at its first glob segment: list files under `dir`, match the rest against `pattern`. */
function outsideGlob(root: string, glob: string): { dir: string; pattern: string } {
	const segments = resolve(root, glob).split("/");
	const first = segments.findIndex((segment) => GLOB_CHARS.test(segment));
	if (first === -1) return { dir: dirname(segments.join("/")), pattern: segments.at(-1) ?? "" };
	return { dir: segments.slice(0, first).join("/") || "/", pattern: segments.slice(first).join("/") };
}

/** Tracked + untracked-not-ignored files under `dir` (relative to it). */
async function listFiles(exec: Exec, dir: string): AsyncResult<string[]> {
	const argv = ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."];
	const listed = await exec(argv, { cwd: dir });
	if (listed.exitCode !== 0) return err(`could not list JS inputs: ${execError(argv, listed)}`);
	return ok([...new Set(listed.stdout.split("\0").filter(Boolean))]);
}

/** Project-root-relative paths of every file `globs` match: plain globs under the root, `../` globs wherever they point. */
async function matchedInputs(deps: JsInputsDeps): AsyncResult<string[]> {
	const inside = deps.jsInputs.filter((g) => !g.startsWith("../"));
	const matched = new Set<string>();
	if (inside.length > 0) {
		const all = await listFiles(deps.exec, deps.root);
		if (!all.success) return all;
		for (const path of matchJsInputs(all.data, inside)) matched.add(path);
	}
	for (const glob of deps.jsInputs.filter((g) => g.startsWith("../"))) {
		const { dir, pattern } = outsideGlob(deps.root, glob);
		const all = await listFiles(deps.exec, dir);
		if (!all.success) return all;
		for (const path of matchJsInputs(all.data, [pattern])) matched.add(relative(deps.root, join(dir, path)));
	}
	return ok([...matched].sort());
}

/**
 * Content hash of the project's JS sources: every tracked or untracked-not-ignored file that
 * matches `jsInputs`, hashed as sorted `path NUL sha256(content)` lines — so renames count and
 * ignored build output never does. Globs are relative to the project root; a glob starting with
 * `../` reaches outside it (a workspace package the bundle embeds) and its files are keyed by their
 * root-relative path, so the hash is the same in every checkout. Errors when nothing matches (the
 * globs are wrong; an empty hash would silently never change).
 */
export async function jsInputsHash(deps: JsInputsDeps): AsyncResult<string> {
	const matched = await matchedInputs(deps);
	if (!matched.success) return matched;
	const read = deps.readFile ?? readFileOrUndefined;
	const lines: string[] = [];
	for (const path of matched.data) {
		const bytes = await read(join(deps.root, path));
		if (bytes !== undefined) lines.push(`${path}\0${sha256(bytes)}`);
	}
	if (lines.length === 0) {
		return err(`fingerprint.jsInputs (${deps.jsInputs.join(", ")}) matched no files under ${deps.root}`);
	}
	return ok(sha256(lines.join("\n")));
}

/** The cache / install key of a JS-aware project: 40 hex chars like an `@expo/fingerprint` hash. */
export function combineKey(native: string, js: string): string {
	return sha256(`native:${native}\njs:${js}`).slice(0, 40);
}
