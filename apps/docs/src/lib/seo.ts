import { appDescription, appName, docsRoute, ogImagePath, siteUrl } from "./shared";

export type HeadMeta = { title: string } | { name: string; content: string } | { property: string; content: string };

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
} {
	const pageTitle = slugs.length === 0 ? `${appName} docs` : `${title} — ${appName}`;
	const body = description || appDescription;

	return {
		meta: [
			{ title: pageTitle },
			{ name: "description", content: body },
			{ property: "og:title", content: pageTitle },
			{ property: "og:description", content: body },
			{ property: "og:url", content: [siteUrl + docsRoute, ...slugs].join("/") },
			...socialImageMeta(ogImagePath(slugs), pageTitle),
		],
	};
}
