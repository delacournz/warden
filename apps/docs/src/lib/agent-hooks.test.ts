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

/** The exact phrasings a page may use to name the PreToolUse hook as retired. */
const RETIRED_PHRASES = [
	"removes the `PreToolUse` hook",
	"There is no PreToolUse hook",
	"a PreToolUse hook written by an older warden",
] as const;

/** Whether every PreToolUse mention on `line` sits inside an allow-listed retired phrase. */
function onlyRetiredMentions(line: string): boolean {
	const rest = RETIRED_PHRASES.reduce((acc, phrase) => acc.split(phrase).join(""), line);
	return !rest.includes("PreToolUse");
}

describe("agent hook claims", () => {
	test("allow-list matches retired phrasings only", () => {
		expect(onlyRetiredMentions("It also removes the `PreToolUse` hook that older versions installed.")).toBe(true);
		expect(onlyRetiredMentions("There is no PreToolUse hook to install or forget:")).toBe(true);
		expect(onlyRetiredMentions("An older warden used it; the PreToolUse hook auto-claims a device.")).toBe(false);
		expect(onlyRetiredMentions("warden install removes stale config and adds a PreToolUse hook.")).toBe(false);
		expect(onlyRetiredMentions("There is no PreToolUse hook, but PreToolUse blocks foreign taps.")).toBe(false);
	});

	test("PreToolUse is only mentioned as retired: `warden install` adds just the SessionEnd hook", () => {
		const claims = pages().flatMap((file) =>
			readFileSync(file, "utf8")
				.split("\n")
				.map((line, i) => ({ at: `${file.slice(docsRoot.length + 1)}:${i + 1}`, line }))
				.filter(({ line }) => !onlyRetiredMentions(line))
				.map(({ at }) => at)
		);
		expect(claims).toEqual([]);
	});
});
