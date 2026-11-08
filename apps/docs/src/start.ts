import { redirect } from "@tanstack/react-router";
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { isMarkdownPreferred } from "fumadocs-core/negotiation";
import { reportAgentFetch } from "@/lib/analytics/server";
import { trailingSlashTarget } from "@/lib/redirects";
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

/**
 * `/docs/e2e/` answers with a permanent 308 to `/docs/e2e`, so search engines
 * keep one URL per page. The router's own normalization is a temporary 307.
 */
const trailingSlashMiddleware = createMiddleware().server(({ next, request }) => {
	const target = trailingSlashTarget(new URL(request.url));
	if (target) throw redirect({ href: target, statusCode: 308 });
	return next();
});

/** Rejects cross-site calls to server fns (same-origin RPC only). */
const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * Counts reads of the Markdown the site serves to agents, see
 * `src/lib/analytics/server.ts`. `llmMiddleware`'s `Accept: text/markdown`
 * redirect is not counted here; the `.md` request it redirects to is.
 */
const analyticsMiddleware = createMiddleware().server(({ next, request }) => {
	reportAgentFetch(request);
	return next();
});

export const startInstance = createStart(() => {
	return {
		requestMiddleware: [trailingSlashMiddleware, csrfMiddleware, analyticsMiddleware, llmMiddleware],
	};
});
