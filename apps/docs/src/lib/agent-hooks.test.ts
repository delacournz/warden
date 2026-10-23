import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const docsRoot = join(import.meta.dir, "../..");

/** Every `.mdx` page under `content/docs`, plus the landing page. */
function pages(): string[] {
	const content = join(docsRoot, "content/docs");
	const mdx = readdirSync(content, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".mdx"))
		.map((f) => join(content, f));
	return [...mdx, join(docsRoot, "src/routes/index.tsx"), join(docsRoot, "PRODUCT.md")];
}

/** A line that names the PreToolUse hook only to say it was retired. */
const RETIRED = /older|removes|no PreToolUse/i;

describe("agent hook claims", () => {
	test("PreToolUse is only mentioned as retired: `warden install` adds just the SessionEnd hook", () => {
		const claims = pages().flatMap((file) =>
			readFileSync(file, "utf8")
				.split("\n")
				.map((line, i) => ({ at: `${file.slice(docsRoot.length + 1)}:${i + 1}`, line }))
				.filter(({ line }) => line.includes("PreToolUse") && !RETIRED.test(line))
				.map(({ at }) => at)
		);
		expect(claims).toEqual([]);
	});
});
