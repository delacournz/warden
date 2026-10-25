import { dirname, relative } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";

/** `Sign in!` → `sign-in`: the file name a recording's name gives its spec. Empty when nothing usable is left. */
export function slugOf(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "");
}

export type HelperRef = { module: string; fn: string };

const FUNCTION_NAME = /^[A-Za-z_$][\w$]*$/;

/** `--helper e2e/helpers.ts#signIn` → the module path (`.ts` added when it has no extension) and the function name. */
export function parseHelperRef(raw: string, flag = "--helper"): Result<HelperRef> {
	const at = raw.lastIndexOf("#");
	const module = at === -1 ? "" : raw.slice(0, at).trim();
	const fn = at === -1 ? "" : raw.slice(at + 1).trim();
	if (module === "" || fn === "")
		return err(`${flag} takes <module>#${flag === "--options" ? "<name>" : "<function>"}, got "${raw}"`);
	if (!FUNCTION_NAME.test(fn)) return err(`"${fn}" is not a valid ${flag === "--options" ? "name" : "function name"}`);
	return ok({ module: /\.[cm]?[jt]sx?$/.test(module) ? module : `${module}.ts`, fn });
}

/** Whether `source` already exports `fn` (a function, const, let, var or class declaration). */
export function exportsName(source: string, fn: string): boolean {
	return new RegExp(
		`^export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${fn.replaceAll("$", "\\$")}\\b`,
		"m"
	).test(source);
}

/** `./ids` for an ids module next to (or below) `from`, `../ids` above it; never with the extension. */
export function importPath(from: string, idsFile: string): string {
	const rel = relative(dirname(from), idsFile).replace(/\.[cm]?[jt]s$/, "");
	return rel.startsWith(".") ? rel : `./${rel}`;
}

/** End of the quoted string starting at `at` (its closing quote, or the source length when unterminated). */
function skipString(source: string, at: number, quote: string): number {
	let end = at + 1;
	for (; end < source.length && source.charAt(end) !== quote; end += 1) {
		if (source.charAt(end) === "\\") end += 1;
	}
	return end;
}

/** Last index of the comment or string starting at `at`; `at` itself when none starts there; -1 when unterminated. */
function skipLiteral(source: string, at: number): number {
	const ch = source.charAt(at);
	const next = source.charAt(at + 1);
	if (ch === "/" && next === "/") return source.indexOf("\n", at);
	if (ch === "/" && next === "*") {
		const end = source.indexOf("*/", at + 2);
		return end === -1 ? -1 : end + 1;
	}
	if (ch === '"' || ch === "'" || ch === "`") return skipString(source, at, ch);
	return at;
}

/** Index of the bracket closing the one at `open`, skipping strings and comments; -1 when unbalanced. */
function closingIndex(source: string, open: number): number {
	const pairs: Record<string, string> = { "(": ")", "{": "}" };
	const opener = source.charAt(open);
	const closer = pairs[opener];
	if (closer === undefined) return -1;
	let depth = 0;
	for (let at = open; at < source.length; at += 1) {
		const skipped = skipLiteral(source, at);
		if (skipped === -1) return -1;
		if (skipped !== at) {
			at = skipped;
			continue;
		}
		const ch = source.charAt(at);
		if (ch === opener) depth += 1;
		else if (ch === closer) {
			depth -= 1;
			if (depth === 0) return at;
		}
	}
	return -1;
}

/**
 * The text of `fn`'s declaration in `source` (`function fn(...) { … }` or `const fn = (...) => { … }`, exported or not),
 * or undefined when there is none or its braces do not balance. Brackets in strings and comments are skipped; a
 * template literal is skipped as a whole, so a `${ … }` inside one is not read.
 */
export function functionSource(source: string, fn: string): string | undefined {
	const name = fn.replaceAll("$", "\\$");
	const declaration = new RegExp(
		`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:(?:async\\s+)?function\\s*\\*?\\s+${name}\\b|const\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?)`
	).exec(source);
	if (!declaration) return undefined;
	const start = declaration.index + (declaration[0].startsWith("\n") ? 1 : 0);
	const params = source.indexOf("(", declaration.index + declaration[0].length);
	if (params === -1) return undefined;
	const paramsEnd = closingIndex(source, params);
	if (paramsEnd === -1) return undefined;
	const bodyAt = source.indexOf("{", paramsEnd);
	if (bodyAt === -1) return undefined;
	const bodyEnd = closingIndex(source, bodyAt);
	return bodyEnd === -1 ? undefined : source.slice(start, bodyEnd + 1);
}

const OPENS_APP = /\bapp\.open\s*\(/;
const CALL = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const MAX_DEPTH = 4;

/**
 * Whether running `fn` opens (launches) the app: its body calls `app.open(` (any `app` / `fixtures.app` spelling), or
 * calls a function declared in the same module that does, up to four calls deep. Functions imported from another
 * module are not followed, so a helper that only delegates across modules reads as not opening it.
 */
export function helperOpensApp(source: string, fn: string): boolean {
	const seen = new Set<string>();
	const visit = (name: string, depth: number): boolean => {
		if (seen.has(name) || depth > MAX_DEPTH) return false;
		seen.add(name);
		const body = functionSource(source, name);
		if (body === undefined) return false;
		if (OPENS_APP.test(body)) return true;
		return [...body.matchAll(CALL)].some((call) => (call[1] ?? "") !== "" && visit(call[1] ?? "", depth + 1));
	};
	return visit(fn, 0);
}
