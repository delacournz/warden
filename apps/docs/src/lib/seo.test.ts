import { describe, expect, test } from "bun:test";
import {
	canonicalLink,
	docsHead,
	type HeadMeta,
	markdownHeaders,
	socialImageMeta,
	softwareApplicationJsonLd,
} from "./seo";
import { githubUrl, ogImagePath, siteUrl } from "./shared";

function property(meta: HeadMeta[], name: string): string | undefined {
	for (const tag of meta) {
		if ("property" in tag && tag.property === name) return tag.content;
		if ("name" in tag && tag.name === name) return tag.content;
	}
	return undefined;
}

describe("siteUrl", () => {
	test("is the production host, not the old delacour.co.nz one", () => {
		expect(siteUrl).toBe("https://warden.co.nz");
	});
});

describe("canonicalLink", () => {
	test("absolute on the production host", () => {
		expect(canonicalLink("/docs/e2e")).toEqual({ rel: "canonical", href: "https://warden.co.nz/docs/e2e" });
	});

	test("the home page keeps its slash", () => {
		expect(canonicalLink("/")).toEqual({ rel: "canonical", href: "https://warden.co.nz/" });
	});
});

describe("markdownHeaders", () => {
	test("a page's .md twin names the HTML page as canonical", () => {
		const headers = markdownHeaders(["e2e", "specs"]);
		expect(headers["Content-Type"]).toBe("text/markdown; charset=utf-8");
		expect(headers.Link).toBe('<https://warden.co.nz/docs/e2e/specs>; rel="canonical"');
	});

	test("the docs root", () => {
		expect(markdownHeaders([]).Link).toBe('<https://warden.co.nz/docs>; rel="canonical"');
	});
});

describe("softwareApplicationJsonLd", () => {
	test("a free macOS developer tool, tied to its repository", () => {
		const ld = softwareApplicationJsonLd();
		expect(ld["@context"]).toBe("https://schema.org");
		expect(ld["@type"]).toBe("SoftwareApplication");
		expect(ld.name).toBe("warden");
		expect(ld.url).toBe("https://warden.co.nz/");
		expect(ld.applicationCategory).toBe("DeveloperApplication");
		expect(ld.operatingSystem).toBe("macOS");
		expect(ld.offers).toEqual({ "@type": "Offer", price: "0", priceCurrency: "USD" });
		expect(ld.sameAs).toEqual([githubUrl]);
	});
});

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

	test("every page names itself canonical", () => {
		expect(docsHead({ slugs: ["e2e", "ci"], title: "CI" }).links).toEqual([
			{ rel: "canonical", href: "https://warden.co.nz/docs/e2e/ci" },
		]);
		expect(docsHead({ slugs: [], title: "What is warden" }).links).toEqual([
			{ rel: "canonical", href: "https://warden.co.nz/docs" },
		]);
	});

	test("the docs root title says what warden is", () => {
		const { meta } = docsHead({ slugs: [], title: "What is warden" });
		expect(meta).toContainEqual({ title: "warden docs — mobile testing for coding agents" });
	});
});
