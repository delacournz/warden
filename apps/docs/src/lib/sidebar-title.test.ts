import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { docsSchema, sidebarName } from "./sidebar-title";

const CONTENT = join(import.meta.dirname, "..", "..", "content", "docs");

function mdxUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return mdxUnder(path);
		return path.endsWith(".mdx") ? [path] : [];
	});
}

describe("sidebarName", () => {
	test("a page's sidebarTitle names it in the sidebar", () => {
		expect(sidebarName({ title: "Write React Native E2E tests", sidebarTitle: "Write specs" })).toBe("Write specs");
	});

	test("without one the sidebar keeps the page title", () => {
		expect(sidebarName({ title: "Ports" })).toBeUndefined();
	});
});

describe("docsSchema", () => {
	test("keeps sidebarTitle from the frontmatter", () => {
		const parsed = docsSchema.parse({ title: "Write React Native E2E tests", sidebarTitle: "Write specs" });
		expect(parsed.sidebarTitle).toBe("Write specs");
	});
});

/**
 * The sidebar is a list to scan: a label that wraps onto a second line reads as two items. Pages whose search title
 * is long (the e2e pages carry "React Native E2E" for search) set a short `sidebarTitle`.
 */
describe("sidebar labels", () => {
	const MAX = 24;
	const labels = mdxUnder(CONTENT).map((file) => {
		const text = readFileSync(file, "utf-8");
		const field = (name: string) => text.match(new RegExp(`^${name}: "?(.+?)"?$`, "m"))?.[1];
		return { file: file.slice(CONTENT.length + 1), label: field("sidebarTitle") ?? field("title") ?? "" };
	});

	test(`every page's sidebar label fits on one line (≤ ${MAX} characters)`, () => {
		expect(labels.filter(({ label }) => label.length > MAX).map(({ file, label }) => `${file}: ${label}`)).toEqual([]);
	});
});
