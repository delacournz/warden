import { describe, expect, test } from "bun:test";
import { docsHead, type HeadMeta, socialImageMeta } from "./seo";
import { ogImagePath, siteUrl } from "./shared";

function property(meta: HeadMeta[], name: string): string | undefined {
	for (const tag of meta) {
		if ("property" in tag && tag.property === name) return tag.content;
		if ("name" in tag && tag.name === name) return tag.content;
	}
	return undefined;
}

describe("ogImagePath", () => {
	test("docs root", () => {
		expect(ogImagePath([])).toBe("/og/docs/index.png");
	});

	test("nested page mirrors its slugs", () => {
		expect(ogImagePath(["guides", "agents"])).toBe("/og/docs/guides/agents.png");
	});
});

describe("socialImageMeta", () => {
	test("absolute image, its size, and the large twitter card", () => {
		const meta = socialImageMeta("/og/default.png", "warden");
		expect(property(meta, "og:image")).toBe(`${siteUrl}/og/default.png`);
		expect(property(meta, "og:image:width")).toBe("1200");
		expect(property(meta, "og:image:height")).toBe("630");
		expect(property(meta, "og:image:alt")).toBe("warden");
		expect(property(meta, "twitter:card")).toBe("summary_large_image");
		expect(property(meta, "twitter:image")).toBe(`${siteUrl}/og/default.png`);
	});
});

describe("docsHead", () => {
	test("a page points at its own card", () => {
		const { meta } = docsHead({ slugs: ["guides", "agents"], title: "Agents", description: "Hooks." });
		expect(property(meta, "og:image")).toBe(`${siteUrl}/og/docs/guides/agents.png`);
		expect(property(meta, "og:image:alt")).toBe("Agents — warden");
	});

	test("og:url is absolute", () => {
		const { meta } = docsHead({ slugs: ["guides", "agents"], title: "Agents" });
		expect(property(meta, "og:url")).toBe(`${siteUrl}/docs/guides/agents`);
	});

	test("docs root", () => {
		const { meta } = docsHead({ slugs: [], title: "Introduction" });
		expect(property(meta, "og:image")).toBe(`${siteUrl}/og/docs/index.png`);
		expect(property(meta, "og:url")).toBe(`${siteUrl}/docs`);
	});
});
