import { createFileRoute } from "@tanstack/react-router";
import { sitemapPaths, sitemapXml } from "@/lib/sitemap";
import { source } from "@/lib/source";

export const Route = createFileRoute("/sitemap.xml")({
	server: {
		handlers: {
			GET() {
				const paths = sitemapPaths(source.getPages().map((page) => page.url));
				return new Response(sitemapXml(paths), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
			},
		},
	},
});
