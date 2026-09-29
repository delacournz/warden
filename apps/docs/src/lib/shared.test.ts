import { describe, expect, test } from "bun:test";
import { decodeMarkdownUrl, encodeMarkdownUrl, isFileHref } from "./shared";

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
