import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { docsTitle } from "./seo";

/**
 * The e2e pages answer "react native e2e testing" and its neighbours, so each one's title and description carry the
 * query. A page retitled back to "Suites" or "CI" would drop out of those results without any other test failing.
 */

const E2E = join(import.meta.dirname, "..", "..", "content", "docs", "e2e");

function frontmatter(file: string): { title: string; description: string } {
	const source = readFileSync(join(E2E, file), "utf-8");
	const field = (name: string) => source.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1] ?? "";
	return { title: field("title"), description: field("description") };
}

/** The top-level e2e pages and the CI section's pages (`ci/index.mdx` is `/docs/e2e/ci`). */
const PAGES = [
	...readdirSync(E2E).filter((file) => file.endsWith(".mdx")),
	...readdirSync(join(E2E, "ci"))
		.filter((file) => file.endsWith(".mdx"))
		.map((file) => `ci/${file}`),
];

describe("the e2e docs pages", () => {
	test("the scan sees the pages", () => {
		expect(PAGES).toEqual(
			expect.arrayContaining([
				"index.mdx",
				"specs.mdx",
				"suites.mdx",
				"ci/index.mdx",
				"ci/github-actions.mdx",
				"ci/eas-workflows.mdx",
			])
		);
	});

	for (const file of PAGES) {
		const { title, description } = frontmatter(file);

		test(`${file} is titled for React Native E2E testing`, () => {
			expect(title).toMatch(/React Native/);
			expect(title).toMatch(/E2E|end-to-end/i);
		});

		test(`${file} says React Native or Expo in its description, within a result snippet`, () => {
			expect(description).toMatch(/React Native|Expo/);
		});

		test(`${file} keeps a result title within 60 characters`, () => {
			expect(docsTitle(title, ["e2e", ...file.replace(/(\/index)?\.mdx$/, "").split("/")]).length).toBeLessThanOrEqual(
				60
			);
		});
	}
});
