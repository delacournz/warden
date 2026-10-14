import { describe, expect, test } from "bun:test";
import { clamp, parseFrontmatter, slugsForFile } from "./pages";

describe("parseFrontmatter", () => {
	test("reads the leading block", () => {
		const mdx = "---\ntitle: Agents\ndescription: Hooks that lease devices: one per session.\nicon: Bot\n---\n\nBody\n";
		expect(parseFrontmatter(mdx)).toEqual({
			title: "Agents",
			description: "Hooks that lease devices: one per session.",
			icon: "Bot",
		});
	});

	test("strips matching quotes", () => {
		expect(parseFrontmatter(`---\ntitle: "warden.config.ts"\n---\n`)).toEqual({ title: "warden.config.ts" });
	});

	test("no block is no fields", () => {
		expect(parseFrontmatter("# Heading\n\ntitle: not frontmatter\n")).toEqual({});
	});

	test("a rule later in the body is not frontmatter", () => {
		expect(parseFrontmatter("---\ntitle: A\n---\n\n---\ntitle: B\n---\n")).toEqual({ title: "A" });
	});
});

describe("slugsForFile", () => {
	test("root index is the docs root", () => {
		expect(slugsForFile("index.mdx")).toEqual([]);
	});

	test("nested page", () => {
		expect(slugsForFile("guides/agents.mdx")).toEqual(["guides", "agents"]);
	});

	test("folder index takes the folder's slug", () => {
		expect(slugsForFile("reference/index.mdx")).toEqual(["reference"]);
	});
});

describe("clamp", () => {
	test("short text is untouched", () => {
		expect(clamp("Ports", 20)).toBe("Ports");
	});

	test("cuts at a word boundary and drops trailing punctuation", () => {
		expect(clamp("Claim devices and ports, released on exit.", 26)).toBe("Claim devices and ports…");
	});
});
