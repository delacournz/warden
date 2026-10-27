import { privacyRoute, siteUrl } from "./shared";

/**
 * Every URL meant for search: the landing page, each docs page and the privacy
 * policy. Markdown twins, the llms files and raw bench artifacts stay out.
 */
export function sitemapPaths(docsUrls: readonly string[]): string[] {
	return [...new Set(["/", ...docsUrls, privacyRoute])];
}

const escapeXml = (text: string) =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

/** A sitemap of `paths` on the production host. No `lastmod`: build time is not when a page last changed. */
export function sitemapXml(paths: readonly string[]): string {
	const urls = paths.map((path) => `<url><loc>${escapeXml(siteUrl + path)}</loc></url>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
