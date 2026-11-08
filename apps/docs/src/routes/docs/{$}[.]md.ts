import { createFileRoute, notFound } from "@tanstack/react-router";
import { redirectSlugs } from "@/lib/redirects";
import { markdownHeaders } from "@/lib/seo";
import { decodeMarkdownUrl, encodeMarkdownUrl } from "@/lib/shared";
import { getLLMText, source } from "@/lib/source";

export const Route = createFileRoute("/docs/{$}.md")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const slugs = decodeMarkdownUrl(params._splat?.split("/") ?? []);
				const page = source.getPage(slugs);
				if (!page) {
					const moved = redirectSlugs(slugs);
					if (moved) return Response.redirect(new URL(encodeMarkdownUrl(moved), request.url), 301);
					throw notFound();
				}

				return new Response(await getLLMText(page), { headers: markdownHeaders(page.slugs) });
			},
		},
	},
});
