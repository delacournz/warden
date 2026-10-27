import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/shared";

/** Points crawlers at the sitemap, and names `/llms.txt` somewhere they already look. */
const BODY = `User-agent: *
Allow: /

Sitemap: ${siteUrl}/sitemap.xml

# Every page on this site, as plain Markdown:
#   /llms.txt         an index of every page
#   /llms-full.txt    every page's full content
#   <any docs URL>.md that one page
`;

export const Route = createFileRoute("/robots.txt")({
	server: {
		handlers: {
			GET() {
				return new Response(BODY, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
			},
		},
	},
});
