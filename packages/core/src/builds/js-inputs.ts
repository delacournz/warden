import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * Content hash of the project's JS sources: every tracked or untracked-not-ignored file under the
 * root that matches `jsInputs`, hashed as sorted `path NUL sha256(content)` lines — so renames count
 * and ignored build output never does. Errors when nothing matches (the globs are wrong; an empty hash
 * would silently never change).
 */
export async function jsInputsHash(deps: JsInputsDeps): AsyncResult<string> {
	const argv = ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."];
	const listed = await deps.exec(argv, { cwd: deps.root });
	if (listed.exitCode !== 0) return err(`could not list JS inputs: ${execError(argv, listed)}`);
	const all = [...new Set(listed.stdout.split("\0").filter(Boolean))];
	const matched = matchJsInputs(all, deps.jsInputs).sort();
	const read = deps.readFile ?? readFileOrUndefined;
	const lines: string[] = [];
	for (const path of matched) {
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
