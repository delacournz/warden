import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ComponentSource } from "@delacour/warden-perf/react/analyze";
import { declarationName, findDeclaration } from "@delacour/warden-perf/react/source-grep";

const SOURCE_EXT = /\.(tsx|jsx|ts|js)$/;
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"ios",
	"android",
	"build",
	"dist",
	".expo",
	"Pods",
	".next",
	"coverage",
]);
const MAX_FILES = 8000;
const MAX_FILE_BYTES = 512 * 1024;

/** What the grep reaches the file system through; tests inject a fake project. */
export type SourceDeps = {
	files: (root: string) => string[];
	read: (path: string) => string | undefined;
};

/** Source files directly in `dir`, plus the sub-directories still to visit. */
function scanDir(dir: string): { files: string[]; dirs: string[] } {
	const files: string[] = [];
	const dirs: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { files, dirs };
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
		if (SOURCE_EXT.test(name)) files.push(join(dir, name));
		else if (!name.includes(".")) dirs.push(join(dir, name));
	}
	return { files, dirs };
}

export const defaultSourceDeps: SourceDeps = {
	files(root) {
		const found: string[] = [];
		const stack = [root];
		while (stack.length > 0 && found.length < MAX_FILES) {
			const scanned = scanDir(stack.pop() ?? root);
			found.push(...scanned.files);
			stack.push(...scanned.dirs);
		}
		return found.sort();
	},
	read(path) {
		try {
			if (statSync(path).size > MAX_FILE_BYTES) return undefined;
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
};

export type DeviceSources = Record<string, { file: string; line: number }>;

const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

/** Project-relative when the file lives under `cwd`, else as given. */
function shown(cwd: string, file: string): string {
	return inside(cwd, file) ? relative(cwd, file) : file;
}

/** Claim every name this file declares: `todo` loses what is found. */
function claimDeclared(
	text: string,
	path: string,
	cwd: string,
	todo: Map<string, string>,
	out: Map<string, ComponentSource>
) {
	for (const [name, decl] of todo) {
		if (!text.includes(decl)) continue;
		const line = findDeclaration(text, decl);
		if (line === undefined) continue;
		out.set(name, { file: shown(cwd, path), line });
		todo.delete(name);
	}
}

/**
 * Where each component is declared. The runtime's own report (`_debugSource`) wins; the rest are found by grepping
 * the project under `cwd` for `function Name` / `const Name =` / `class Name` in .tsx/.jsx/.ts/.js (node_modules
 * and native folders skipped). One pass over the files, however many names. Unfound names are simply absent.
 */
export function resolveSources(
	names: readonly string[],
	cwd: string,
	device: DeviceSources,
	deps: SourceDeps = defaultSourceDeps
): Map<string, ComponentSource> {
	const out = new Map<string, ComponentSource>();
	const todo = new Map<string, string>();
	for (const name of names) {
		const known = device[name];
		const decl = declarationName(name);
		if (known !== undefined) out.set(name, { file: shown(cwd, known.file), line: known.line });
		else if (decl !== undefined) todo.set(name, decl);
	}
	for (const path of todo.size === 0 ? [] : deps.files(cwd)) {
		const text = deps.read(path);
		if (text !== undefined) claimDeclared(text, path, cwd, todo, out);
		if (todo.size === 0) break;
	}
	return out;
}
