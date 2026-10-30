import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { icons } from "lucide-react";

/**
 * `lucideIconsPlugin` looks a page's `icon:` up in lucide's `icons` map, which holds canonical names only: a renamed
 * icon (lucide keeps the old name as an alias export) only warns at build time and the sidebar item renders bare.
 */

const CONTENT = join(import.meta.dirname, "..", "..", "content", "docs");

function mdxUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return mdxUnder(path);
		return path.endsWith(".mdx") ? [path] : [];
	});
}

describe("docs page icons", () => {
	test("every frontmatter icon is a canonical lucide icon", () => {
		const unknown = mdxUnder(CONTENT).flatMap((file) => {
			const icon = readFileSync(file, "utf-8").match(/^icon: (\S+)$/m)?.[1];
			return icon && !(icon in icons) ? [`${file.slice(CONTENT.length + 1)}: ${icon}`] : [];
		});
		expect(unknown).toEqual([]);
	});

	test("the release notes page icon is canonical", () => {
		const icon = readFileSync(join(import.meta.dirname, "release-notes.ts"), "utf-8").match(/"icon: (\w+)"/)?.[1];
		expect(icon && icon in icons).toBe(true);
	});
});
