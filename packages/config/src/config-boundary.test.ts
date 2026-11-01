import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = import.meta.dir;

/** Module specifiers a source text imports (static, side-effect, dynamic); comments ignored. */
function importSpecifiers(rawSource: string): string[] {
	const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
	const found = new Set<string>();
	for (const pattern of [
		/\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*["']([^"']+)["']/g,
		/\bimport\(\s*["']([^"']+)["']\s*\)/g,
	]) {
		for (const m of source.matchAll(pattern)) if (m[1] !== undefined) found.add(m[1]);
	}
	return [...found];
}

const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/**
 * `@delacour/warden-config` is a standalone leaf: its modules import only each other (`./x`), zod,
 * `@delacour/warden-types` and `node:*`. Nothing else in the workspace may sit below it.
 */
describe("warden-config boundary", () => {
	test("sources import only siblings, zod, warden-types and node", () => {
		const violations: string[] = [];
		for (const file of files) {
			for (const spec of importSpecifiers(readFileSync(join(SRC_DIR, file), "utf8"))) {
				const ok =
					spec.startsWith("./") ||
					spec === "zod" ||
					spec.startsWith("@delacour/warden-types/") ||
					spec.startsWith("node:") ||
					spec === "bun:test";
				if (!ok) violations.push(`${file} -> ${spec}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("sibling imports resolve to existing modules", () => {
		const names = new Set(files.map((f) => f.replace(/\.ts$/, "")));
		const missing: string[] = [];
		for (const file of files) {
			for (const spec of importSpecifiers(readFileSync(join(SRC_DIR, file), "utf8"))) {
				if (spec.startsWith("./") && !names.has(spec.slice(2))) missing.push(`${file} -> ${spec}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
