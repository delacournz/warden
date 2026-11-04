import {
	appDescription,
	appName,
	docsRoute,
	encodeMarkdownUrl,
	githubUrl,
	metaDescription,
	ogImagePath,
	siteUrl,
} from "./shared";

/** Who writes and publishes warden and its docs. */
export const publisherName = "Delacour";

export type HeadMeta = { title: string } | { name: string; content: string } | { property: string; content: string };

export type HeadLink =
	| { rel: "canonical"; href: string }
	| { rel: "alternate"; type: "text/markdown" | "text/plain"; href: string; title?: string };

/** What every search result title says after a short page name. */
const titleSuffix = "iOS & Android simulators for AI agents";

/** Google shows about 60 characters of a title. */
const maxTitleLength = 60;

/** `CI — warden: iOS & Android simulators for AI agents` when it fits in 60 characters, else `<title> — warden`. */
export function docsTitle(title: string): string {
	const long = `${title} — ${appName}: ${titleSuffix}`;
	return long.length <= maxTitleLength ? long : `${title} — ${appName}`;
}

/** The site's tagline, after the name in the landing and docs-root titles. */
export const tagline = "every agent gets its own simulator";

/** The preferred URL for `path` on the production host, so every host and the `.md` twins consolidate to it. */
export function canonicalLink(path: string): HeadLink {
	return { rel: "canonical", href: `${siteUrl}${path}` };
}

/** What the build baked from `public/og` (see `src/og/versions.ts`); empty in tests and before `seo:assets`. */
const builtOgVersions: Record<string, string> = typeof __OG_VERSIONS__ === "undefined" ? {} : __OG_VERSIONS__;

/**
 * The 1200×630 card at `path` (see `scripts/generate-og.ts`), for OpenGraph and Twitter readers.
 * A versioned card gets `?v=<hash>`, so a redrawn card is a new URL every unfurler fetches afresh.
 */
export function socialImageMeta(
	path: string,
	alt: string,
	versions: Record<string, string> = builtOgVersions
): HeadMeta[] {
	const version = versions[path];
	const url = version ? `${siteUrl}${path}?v=${version}` : `${siteUrl}${path}`;

	return [
		{ property: "og:image", content: url },
		{ property: "og:image:type", content: "image/png" },
		{ property: "og:image:width", content: "1200" },
		{ property: "og:image:height", content: "630" },
		{ property: "og:image:alt", content: alt },
		{ name: "twitter:card", content: "summary_large_image" },
		{ name: "twitter:image", content: url },
	];
}

/** Every tag a docs page owns; TanStack Router keeps the deepest route's copy of each. */
export function docsHead({
	slugs,
	title,
	description,
}: {
	slugs: readonly string[];
	title: string;
	description?: string;
}): {
	meta: HeadMeta[];
	links: HeadLink[];
} {
	const pageTitle = slugs.length === 0 ? `${appName} docs — ${tagline}` : docsTitle(title);
	const body = description || metaDescription;
	const path = [docsRoute, ...slugs].join("/");

	return {
		meta: [
			{ title: pageTitle },
			{ name: "description", content: body },
			{ name: "author", content: publisherName },
			{ property: "og:type", content: "article" },
			{ property: "og:title", content: pageTitle },
			{ property: "og:description", content: body },
			{ property: "og:url", content: siteUrl + path },
			{ name: "twitter:title", content: pageTitle },
			{ name: "twitter:description", content: body },
			...socialImageMeta(ogImagePath(slugs), pageTitle),
		],
		links: [canonicalLink(path), { rel: "alternate", type: "text/markdown", href: encodeMarkdownUrl([...slugs]) }],
	};
}

/**
 * Headers for a docs page's `.md` twin. The `Link` header points search
 * engines at the HTML page, so the twin never competes with it in results.
 */
export function markdownHeaders(slugs: readonly string[]): { "Content-Type": string; Link: string } {
	const { href } = canonicalLink([docsRoute, ...slugs].join("/"));
	return { "Content-Type": "text/markdown; charset=utf-8", Link: `<${href}>; rel="canonical"` };
}

type SoftwareApplicationJsonLd = {
	"@context"?: "https://schema.org";
	"@type": "SoftwareApplication";
	name: string;
	description: string;
	url: string;
	applicationCategory: "DeveloperApplication";
	operatingSystem: string;
	offers: { "@type": "Offer"; price: string; priceCurrency: string };
	sameAs: string[];
	downloadUrl?: string;
	softwareRequirements?: string;
	keywords?: string;
	publisher?: { "@id": string };
};

/** schema.org identity for the landing page: what warden is, where it runs, and that it is free. */
export function softwareApplicationJsonLd(): SoftwareApplicationJsonLd {
	return {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: appName,
		description: appDescription,
		url: `${siteUrl}/`,
		applicationCategory: "DeveloperApplication",
		operatingSystem: "macOS",
		offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
		sameAs: [githubUrl],
	};
}

/** The docs entry the redirect at `/docs` lands on, first crumb of every docs breadcrumb. */
const docsHome = `${docsRoute}/getting-started`;

type WebSiteNode = {
	"@type": "WebSite";
	"@id": string;
	name: string;
	url: string;
	description: string;
	publisher: { "@id": string };
};
type OrganizationNode = {
	"@type": "Organization";
	"@id": string;
	name: string;
	url: string;
	logo: string;
	sameAs: string[];
};
type TechArticleNode = {
	"@type": "TechArticle";
	headline: string;
	description: string;
	url: string;
	inLanguage: "en";
	image: string;
	isPartOf: { "@id": string };
	author: { "@id": string };
	publisher: { "@id": string };
};
type BreadcrumbListNode = {
	"@type": "BreadcrumbList";
	itemListElement: { "@type": "ListItem"; position: number; name: string; item: string }[];
};

const websiteId = `${siteUrl}/#website`;
const organizationId = `${siteUrl}/#organization`;

/** A docs page's ancestor or itself, as the breadcrumb shows it. */
export type Crumb = { name: string; path: string };

/** schema.org for every page (root route): the site and who publishes it. */
export function siteJsonLd(): { "@context": "https://schema.org"; "@graph": [WebSiteNode, OrganizationNode] } {
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": websiteId,
				name: appName,
				url: `${siteUrl}/`,
				description: metaDescription,
				publisher: { "@id": organizationId },
			},
			{
				"@type": "Organization",
				"@id": organizationId,
				name: publisherName,
				url: `${siteUrl}/`,
				logo: `${siteUrl}/favicon.svg`,
				sameAs: [githubUrl, `https://github.com/${githubUrl.split("/")[3]}`],
			},
		],
	};
}

type FaqPageNode = {
	"@type": "FAQPage";
	mainEntity: { "@type": "Question"; name: string; acceptedAnswer: { "@type": "Answer"; text: string } }[];
};

/** Markdown code ticks read as noise in a plain-text answer. */
const plain = (text: string) => text.replace(/`/g, "");

/** schema.org for the landing page: what warden is, and the FAQ the page shows. */
export function landingJsonLd(faq: readonly { q: string; a: string }[]): {
	"@context": "https://schema.org";
	"@graph": [SoftwareApplicationJsonLd, FaqPageNode];
} {
	const { "@context": _context, ...app } = softwareApplicationJsonLd();
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				...app,
				downloadUrl: "https://www.npmjs.com/package/@delacour/warden",
				softwareRequirements: "macOS with Xcode for iOS simulators; Android SDK for emulators",
				keywords: "iOS simulator, Android emulator, AI coding agents, React Native e2e testing, Expo, parallel testing",
				publisher: { "@id": organizationId },
			},
			{
				"@type": "FAQPage",
				mainEntity: faq.map((item) => ({
					"@type": "Question",
					name: plain(item.q),
					acceptedAnswer: { "@type": "Answer", text: plain(item.a) },
				})),
			},
		],
	};
}

/** schema.org for a docs page: the article itself and its breadcrumb trail from the docs home. */
export function docsJsonLd({
	slugs,
	title,
	description,
	crumbs,
}: {
	slugs: readonly string[];
	title: string;
	description?: string;
	crumbs: readonly Crumb[];
}): { "@context": "https://schema.org"; "@graph": [TechArticleNode, BreadcrumbListNode] } {
	const url = siteUrl + [docsRoute, ...slugs].join("/");
	const seen = new Set<string>();
	const trail = [{ name: "Docs", path: docsHome }, ...crumbs].filter((crumb) => {
		if (seen.has(crumb.path)) return false;
		seen.add(crumb.path);
		return true;
	});

	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "TechArticle",
				headline: title,
				description: description || metaDescription,
				url,
				inLanguage: "en",
				image: siteUrl + ogImagePath(slugs),
				isPartOf: { "@id": websiteId },
				author: { "@id": organizationId },
				publisher: { "@id": organizationId },
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: trail.map((crumb, index) => ({
					"@type": "ListItem",
					position: index + 1,
					name: crumb.name,
					item: siteUrl + crumb.path,
				})),
			},
		],
	};
}
