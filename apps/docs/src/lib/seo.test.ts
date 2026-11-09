import { describe, expect, test } from "bun:test";
import {
	canonicalLink,
	docsHead,
	docsJsonLd,
	docsRootTitle,
	docsTitle,
	type HeadMeta,
	landingJsonLd,
	landingTitle,
	markdownHeaders,
	siteJsonLd,
	socialImageMeta,
	softwareApplicationJsonLd,
} from "./seo";
import { appDescription, githubUrl, metaDescription, ogImagePath, siteUrl } from "./shared";

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

	test("a built card carries its content version, so X and friends refetch a changed one", () => {
		const meta = socialImageMeta("/og/default.png", "warden", { "/og/default.png": "abc123" });
		expect(property(meta, "og:image")).toBe(`${siteUrl}/og/default.png?v=abc123`);
		expect(property(meta, "twitter:image")).toBe(`${siteUrl}/og/default.png?v=abc123`);
	});

	test("a card the build never versioned stays bare", () => {
		const meta = socialImageMeta("/og/docs/index.png", "warden", { "/og/default.png": "abc123" });
		expect(property(meta, "og:image")).toBe(`${siteUrl}/og/docs/index.png`);
	});
});

describe("docsHead", () => {
	test("a page points at its own card", () => {
		const { meta } = docsHead({ slugs: ["guides", "agents"], title: "Agents", description: "Hooks." });
		expect(property(meta, "og:image")).toBe(`${siteUrl}/og/docs/guides/agents.png`);
		expect(property(meta, "og:image:alt")).toBe("Agents — warden: iOS & Android simulators for AI agents");
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

	test("every page names itself canonical and links its Markdown twin for agents", () => {
		expect(docsHead({ slugs: ["e2e", "ci"], title: "CI" }).links).toEqual([
			{ rel: "canonical", href: "https://warden.co.nz/docs/e2e/ci" },
			{ rel: "alternate", type: "text/markdown", href: "/docs/e2e/ci.md" },
		]);
		expect(docsHead({ slugs: [], title: "What is warden" }).links).toEqual([
			{ rel: "canonical", href: "https://warden.co.nz/docs" },
			{ rel: "alternate", type: "text/markdown", href: "/docs/index.md" },
		]);
	});

	test("an article for OpenGraph, with Twitter's own title and description", () => {
		const { meta } = docsHead({ slugs: ["e2e", "ci"], title: "CI", description: "Run suites in CI." });
		expect(property(meta, "og:type")).toBe("article");
		expect(property(meta, "twitter:title")).toBe(property(meta, "og:title"));
		expect(property(meta, "twitter:description")).toBe("Run suites in CI.");
		expect(property(meta, "author")).toBe("Delacour");
	});

	test("a page without its own description falls back to the short meta description", () => {
		const { meta } = docsHead({ slugs: ["e2e"], title: "E2E" });
		expect(property(meta, "description")).toBe(metaDescription);
	});

	test("the docs root title says what warden is", () => {
		const { meta } = docsHead({ slugs: [], title: "What is warden" });
		expect(meta).toContainEqual({ title: "warden docs — React Native E2E testing for AI agents" });
	});
});

describe("metaDescription", () => {
	test("fits a search result without truncation", () => {
		expect(metaDescription.length).toBeGreaterThanOrEqual(120);
		expect(metaDescription.length).toBeLessThanOrEqual(160);
	});

	test("is shorter than the long card description", () => {
		expect(metaDescription.length).toBeLessThan(appDescription.length);
	});
});

describe("docsTitle", () => {
	test("a short page title carries what warden is, within 60 characters", () => {
		expect(docsTitle("CI")).toBe("CI — warden: iOS & Android simulators for AI agents");
		expect(docsTitle("CI").length).toBeLessThanOrEqual(60);
	});

	test("a long page title keeps only the name", () => {
		expect(docsTitle("Claim & release devices and more words")).toBe("Claim & release devices and more words — warden");
	});

	test("an e2e page carries the React Native E2E suffix, a simulator page keeps the simulator one", () => {
		expect(docsTitle("CI", ["e2e", "ci"])).toBe("CI — warden: React Native & Expo E2E testing");
		expect(docsTitle("CI", ["sims", "ci"])).toBe("CI — warden: iOS & Android simulators for AI agents");
		expect(docsTitle("Debugging", ["e2e", "debugging"]).length).toBeLessThanOrEqual(60);
	});

	test("a long e2e title still falls back to the name", () => {
		expect(docsTitle("React Native E2E tests in GitHub Actions", ["e2e", "ci"])).toBe(
			"React Native E2E tests in GitHub Actions — warden"
		);
	});
});

describe("the landing and docs-root titles", () => {
	test("lead with React Native E2E testing within 60 characters", () => {
		expect(landingTitle).toBe("warden — React Native E2E testing on iOS & Android");
		expect(landingTitle.length).toBeLessThanOrEqual(60);
		expect(docsRootTitle.startsWith("warden docs — React Native E2E testing")).toBe(true);
		expect(docsRootTitle.length).toBeLessThanOrEqual(60);
	});
});

describe("landingJsonLd search metadata", () => {
	const app = landingJsonLd([])["@graph"][0];

	test("the SoftwareApplication names the queries it answers", () => {
		expect(app.applicationSubCategory).toBe("Testing");
		expect(app.keywords).toContain("React Native E2E testing");
		expect(app.keywords).toContain("Expo E2E testing");
		expect(app.featureList).toEqual(expect.arrayContaining(["React Native E2E testing", "Expo E2E testing"]));
		expect(app.featureList?.join(" ")).toMatch(/iOS simulators and Android emulators/);
		expect(app.featureList?.join(" ")).toMatch(/AI coding agents/);
	});
});

describe("docsJsonLd", () => {
	const graph = docsJsonLd({
		slugs: ["e2e", "ci"],
		title: "CI",
		description: "Run suites in CI.",
		crumbs: [
			{ name: "E2E Tests", path: "/docs/e2e" },
			{ name: "CI", path: "/docs/e2e/ci" },
		],
	})["@graph"];

	test("a TechArticle for the page", () => {
		expect(graph[0]).toMatchObject({
			"@type": "TechArticle",
			headline: "CI",
			description: "Run suites in CI.",
			url: `${siteUrl}/docs/e2e/ci`,
			inLanguage: "en",
		});
	});

	test("a TechArticle names its author and publisher", () => {
		expect(graph[0]).toMatchObject({
			author: { "@id": `${siteUrl}/#organization` },
			publisher: { "@id": `${siteUrl}/#organization` },
		});
	});

	test("a crumb repeated by path (a tab and its index page) appears once", () => {
		const items = docsJsonLd({
			slugs: ["e2e"],
			title: "Get started",
			crumbs: [
				{ name: "E2E Tests", path: "/docs/e2e" },
				{ name: "Get started", path: "/docs/e2e" },
			],
		})["@graph"][1].itemListElement;
		expect(items.map((item) => item.name)).toEqual(["Docs", "E2E Tests"]);
	});

	test("a BreadcrumbList from the docs root to the page, absolute and 1-based", () => {
		expect(graph[1]).toEqual({
			"@type": "BreadcrumbList",
			itemListElement: [
				{ "@type": "ListItem", position: 1, name: "Docs", item: `${siteUrl}/docs/getting-started` },
				{ "@type": "ListItem", position: 2, name: "E2E Tests", item: `${siteUrl}/docs/e2e` },
				{ "@type": "ListItem", position: 3, name: "CI", item: `${siteUrl}/docs/e2e/ci` },
			],
		});
	});
});

describe("siteJsonLd", () => {
	test("the WebSite and its publishing Organization, on every page", () => {
		const graph = siteJsonLd()["@graph"];
		expect(graph.map((node) => node["@type"])).toEqual(["WebSite", "Organization"]);
		expect(graph[0]).toMatchObject({ name: "warden", url: `${siteUrl}/`, publisher: { "@id": graph[1]["@id"] } });
		expect(graph[1].sameAs).toContain(githubUrl);
	});
});

describe("landingJsonLd", () => {
	const graph = landingJsonLd([{ q: "Is it `free`?", a: "Yes, `MIT`." }])["@graph"];

	test("the SoftwareApplication, published by the site's Organization", () => {
		expect(graph[0]).toMatchObject({
			"@type": "SoftwareApplication",
			name: "warden",
			publisher: { "@id": `${siteUrl}/#organization` },
		});
	});

	test("the visible FAQ as a FAQPage, code ticks stripped", () => {
		expect(graph[1]).toEqual({
			"@type": "FAQPage",
			mainEntity: [
				{ "@type": "Question", name: "Is it free?", acceptedAnswer: { "@type": "Answer", text: "Yes, MIT." } },
			],
		});
	});
});
