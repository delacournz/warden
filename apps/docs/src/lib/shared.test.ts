import { describe, expect, test } from "bun:test";
import { appDescription, decodeMarkdownUrl, encodeMarkdownUrl, isFileHref, metaDescription } from "./shared";

describe("the search snippets", () => {
	test("lead with the queries warden answers", () => {
		expect(metaDescription).toMatch(/^React Native and Expo E2E testing/);
		expect(metaDescription).toContain("iOS simulators");
		expect(metaDescription).toContain("Android emulators");
		expect(metaDescription).toContain("AI coding agents");
		expect(metaDescription.length).toBeGreaterThanOrEqual(120);
		expect(metaDescription.length).toBeLessThanOrEqual(160);
	});

	test("the long description names React Native and end-to-end testing too", () => {
		expect(appDescription).toMatch(/React Native/);
		expect(appDescription).toMatch(/end-to-end/);
	});
});

describe("encodeMarkdownUrl", () => {
	test("root page is index.md", () => {
		expect(encodeMarkdownUrl([])).toBe("/docs/index.md");
	});

	test("nested page gets .md on its last segment", () => {
		expect(encodeMarkdownUrl(["guides", "agents"])).toBe("/docs/guides/agents.md");
	});
});

describe("decodeMarkdownUrl", () => {
	test("round-trips encodeMarkdownUrl", () => {
		expect(decodeMarkdownUrl(["guides", "agents.md"])).toEqual(["guides", "agents"]);
	});

	test("index.md is the root page", () => {
		expect(decodeMarkdownUrl(["index.md"])).toEqual([]);
	});
});

describe("isFileHref", () => {
	test("files", () => {
		expect(isFileHref("/llms.txt")).toBe(true);
		expect(isFileHref("/docs/installation.md")).toBe(true);
	});

	test("pages, fragments and external links", () => {
		expect(isFileHref("/docs/installation")).toBe(false);
		expect(isFileHref("#rules")).toBe(false);
		expect(isFileHref("https://example.com/a.txt")).toBe(false);
		expect(isFileHref("//cdn.example.com/a.js")).toBe(false);
	});
});
