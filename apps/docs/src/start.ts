import { redirect } from "@tanstack/react-router";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { isMarkdownPreferred } from "fumadocs-core/negotiation";
import { docsRoute, encodeMarkdownUrl } from "@/lib/shared";

/** An agent asking for `Accept: text/markdown` on a docs URL is redirected to that page's `.md` twin. */
const llmMiddleware = createMiddleware().server(({ next, request }) => {
	const url = new URL(request.url);

	if (url.pathname.startsWith(docsRoute) && !url.pathname.endsWith(".md") && isMarkdownPreferred(request)) {
		const slugs = url.pathname
			.slice(docsRoute.length)
			.split("/")
			.filter((v) => v.length > 0);
		url.pathname = encodeMarkdownUrl(slugs);

		throw redirect({ href: url.href, headers: { Vary: "Accept" } });
	}

	return next();
});

export const startInstance = createStart(() => {
	return {
		requestMiddleware: [llmMiddleware],
	};
});
