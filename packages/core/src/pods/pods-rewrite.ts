import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { LOCAL_PODSPEC_PATH } from "./pods.defaults";

/** A root spelling in a cached file and the one it becomes. */
export type RootPair = { from: string; to: string };

/** Bytes as latin1 so rewriting is lossless whatever the encoding; paths are encoded the same way to match. */
const asLatin1 = (text: string): string => Buffer.from(text, "utf8").toString("latin1");
const fromLatin1 = (text: string): Buffer => Buffer.from(text, "latin1");

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One pattern for every `from`, longest first (`/private/tmp/x` before `/tmp/x`), that matches only whole path
 * prefixes: not inside a longer name (`/a/bc` is not `/a/b`) and not as the tail of another path.
 */
export function rootPattern(pairs: readonly RootPair[]): RegExp | undefined {
	const froms = [...new Set(pairs.map((p) => asLatin1(p.from)))].sort((a, b) => b.length - a.length);
	if (froms.length === 0) return undefined;
	return new RegExp(`(?<![A-Za-z0-9_.-])(?:${froms.map(escapeRegex).join("|")})(?![A-Za-z0-9._@+-])`, "g");
}

const sha1 = (data: Buffer): string => createHash("sha1").update(data).digest("hex");

export type RewriteResult = {
	/** old sha1 → new sha1 of each rewritten local podspec */
	checksums: Map<string, string>;
};

/**
 * Rewrite the root in each of `files` (paths relative to `base`), in place. Every local podspec JSON that changed gets its
 * sha1 before and after recorded: a local pod's `SPEC CHECKSUMS` entry is exactly that hash.
 */
export function rewriteRoots(
	base: string,
	files: readonly string[],
	pairs: readonly RootPair[]
): Result<RewriteResult> {
	const checksums = new Map<string, string>();
	const pattern = rootPattern(pairs);
	if (!pattern) return ok({ checksums });
	const target = new Map(pairs.map((p) => [asLatin1(p.from), asLatin1(p.to)]));
	for (const rel of files) {
		const path = join(base, rel);
		if (!existsSync(path)) return err(`cached file missing from the entry: ${rel}`);
		const before = readFileSync(path);
		const after = fromLatin1(before.toString("latin1").replace(pattern, (hit) => target.get(hit) ?? hit));
		if (before.equals(after)) continue;
		writeFileSync(path, after);
		if (LOCAL_PODSPEC_PATH.test(`/${rel}`)) checksums.set(sha1(before), sha1(after));
	}
	return ok({ checksums });
}

/** Replace each old checksum with the new one in the lock file at `path` (absent file: nothing to do). */
export function fixChecksums(path: string, checksums: ReadonlyMap<string, string>): void {
	if (checksums.size === 0 || !existsSync(path)) return;
	let text = readFileSync(path, "utf8");
	for (const [from, to] of checksums) text = text.replaceAll(from, to);
	writeFileSync(path, text);
}

/** `Podfile.lock` and `Pods/Manifest.lock` of `iosDir` are byte-equal (what Xcode's own check compares). */
export function locksMatch(iosDir: string): boolean {
	const lock = join(iosDir, "Podfile.lock");
	const manifest = join(iosDir, "Pods", "Manifest.lock");
	return existsSync(lock) && existsSync(manifest) && readFileSync(lock).equals(readFileSync(manifest));
}

/** Files (relative to `base`) among `files` that still contain a `from` spelling. */
export function leftovers(base: string, files: readonly string[], pairs: readonly RootPair[]): string[] {
	const pattern = rootPattern(pairs);
	if (!pattern) return [];
	return files.filter((rel) => {
		pattern.lastIndex = 0;
		return pattern.test(readFileSync(join(base, rel)).toString("latin1"));
	});
}
