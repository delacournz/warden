import { redirect } from "@tanstack/react-router";
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { isMarkdownPreferred } from "fumadocs-core/negotiation";
import { reportAgentFetch } from "@/lib/analytics/server";
import { markdownTwinTarget, trailingSlashTarget } from "@/lib/redirects";
import { docsRoute } from "@/lib/shared";
import { source } from "@/lib/source";

/** An agent asking for `Accept: text/markdown` on a docs URL is redirected to that page's `.md` twin. */
const llmMiddleware = createMiddleware().server(({ next, request }) => {
	const url = new URL(request.url);

	if (url.pathname.startsWith(docsRoute) && !url.pathname.endsWith(".md") && isMarkdownPreferred(request)) {
		throw redirect({ href: markdownTwinTarget(url), headers: { Vary: "Accept" } });
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
 * `src/lib/analytics/server.ts`, once the read has been answered: only a `200`
 * for a page the site has is counted. `llmMiddleware`'s `Accept: text/markdown`
 * redirect is not counted here; the `.md` request it redirects to is.
 */
const analyticsMiddleware = createMiddleware().server(async ({ next, request }) => {
	const result = await next();
	reportAgentFetch(request, result.response, { pageSlugs: (slugs) => source.getPage(slugs)?.slugs ?? null });
	return result;
});

export const startInstance = createStart(() => {
	return {
		requestMiddleware: [trailingSlashMiddleware, csrfMiddleware, analyticsMiddleware, llmMiddleware],
	};
});
