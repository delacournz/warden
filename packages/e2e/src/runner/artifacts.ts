import { createHash } from "node:crypto";
import { basename, extname, join, relative, sep } from "node:path";

const SLUG_MAX = 60;

/** Lowercase, runs of non-alphanumerics become `-`, trimmed, capped at 60 chars; `fallback` when empty. */
export function slug(text: string, fallback = "test"): string {
	const slugged = text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX)
		.replace(/-+$/g, "");
	return slugged === "" ? fallback : slugged;
}

/** First 6 hex chars of a sha1 over the parts: keeps equal slugs from colliding. */
export function hash6(...parts: string[]): string {
	return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 6);
}

/** `<out>/<specId>/<title-slug>-<hash6>/` for one test attempt. */
export function attemptDir(out: string, specId: string, title: readonly string[], hash: string): string {
	return join(out, specId, `${slug(title.join(" "))}-${hash.slice(0, 6)}`);
}

/** `<dir>/screenshots/NNN-name.png` (3-digit, 1-based order). */
export function screenshotPath(dir: string, n: number, name: string): string {
	return join(dir, "screenshots", `${String(n).padStart(3, "0")}-${slug(name, "screenshot")}.png`);
}

const SPEC_EXT = /\.e2e$/;

/**
 * Stable per-file id: the path under `specsDir` without extension (`auth/sign-in.e2e.ts` →
 * `auth/sign-in`), segments slugged. A file outside `specsDir` (or no `specsDir`) uses its basename.
 */
export function specIdOf(file: string, specsDir?: string): string {
	const strip = (name: string): string => basename(name, extname(name)).replace(SPEC_EXT, "");
	if (specsDir !== undefined) {
		const rel = relative(specsDir, file);
		if (rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`)) {
			const parts = rel.split(sep);
			const last = parts.pop() ?? rel;
			return [...parts.map((p) => slug(p, "dir")), slug(strip(last), "spec")].join("/");
		}
	}
	return slug(strip(file), "spec");
}
