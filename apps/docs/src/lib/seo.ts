import { appDescription, appName, docsRoute, githubUrl, ogImagePath, siteUrl } from "./shared";

export type HeadMeta = { title: string } | { name: string; content: string } | { property: string; content: string };

export type HeadLink = { rel: "canonical"; href: string };

/** The site's tagline, after the name in the landing and docs-root titles. */
export const tagline = "mobile testing for coding agents";

/** The preferred URL for `path` on the production host, so every host and the `.md` twins consolidate to it. */
export function canonicalLink(path: string): HeadLink {
	return { rel: "canonical", href: `${siteUrl}${path}` };
}

/** The 1200×630 card at `path` (see `scripts/generate-og.ts`), for OpenGraph and Twitter readers. */
export function socialImageMeta(path: string, alt: string): HeadMeta[] {
	const url = `${siteUrl}${path}`;

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
	const pageTitle = slugs.length === 0 ? `${appName} docs — ${tagline}` : `${title} — ${appName}`;
	const body = description || appDescription;
	const path = [docsRoute, ...slugs].join("/");

	return {
		meta: [
			{ title: pageTitle },
			{ name: "description", content: body },
			{ property: "og:title", content: pageTitle },
			{ property: "og:description", content: body },
			{ property: "og:url", content: siteUrl + path },
			...socialImageMeta(ogImagePath(slugs), pageTitle),
		],
		links: [canonicalLink(path)],
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
	"@context": "https://schema.org";
	"@type": "SoftwareApplication";
	name: string;
	description: string;
	url: string;
	applicationCategory: "DeveloperApplication";
	operatingSystem: string;
	offers: { "@type": "Offer"; price: string; priceCurrency: string };
	sameAs: string[];
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
