import { siteUrl } from "./shared.ts";

/** Edge-cacheable page policy: browsers revalidate, Railway's edge may serve a shared copy for 5 min then stale for a day. */
const pageCache = "public, max-age=0, s-maxage=300, stale-while-revalidate=86400";

/** Static public files that are not content-hashed: a day in browsers, a week at the edge. */
const staticCache = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";

/**
 * Sent on every response (nitro merges `/**` under each matching rule). Only `frame-ancestors` from
 * CSP: a full policy would have to track PostHog, the demo video and Fumadocs' inline scripts.
 */
const securityHeaders = {
	"Strict-Transport-Security": "max-age=63072000; includeSubDomains",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "SAMEORIGIN",
	"Content-Security-Policy": "frame-ancestors 'self'",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;

/**
 * Nitro `routeRules`: security headers everywhere, Cache-Control per route family. `X-Robots-Tag: noindex`
 * keeps the agent-facing text dumps and the raw bench logs, archives and JSON
 * out of search results; crawlers and agents still fetch them. Hashed
 * `/assets/**` already ship `immutable` from nitro.
 */
export const routeRules = {
	"/**": { headers: securityHeaders },
	"/": { headers: { "Cache-Control": pageCache } },
	"/docs/**": { headers: { "Cache-Control": pageCache, Vary: "Accept" } },
	"/privacy": { headers: { "Cache-Control": pageCache } },
	"/llms.txt": { headers: { "Cache-Control": pageCache, "X-Robots-Tag": "noindex" } },
	"/llms-full.txt": { headers: { "Cache-Control": pageCache, "X-Robots-Tag": "noindex" } },
	"/robots.txt": { headers: { "Cache-Control": staticCache } },
	"/sitemap.xml": { headers: { "Cache-Control": staticCache } },
	"/bench/**": { headers: { "Cache-Control": staticCache, "X-Robots-Tag": "noindex" } },
	"/demos/**": { headers: { "Cache-Control": staticCache } },
	"/og/**": { headers: { "Cache-Control": staticCache } },
	"/favicon.svg": { headers: { "Cache-Control": staticCache } },
} as const;

/**
 * `noindex` for every host but production: staging (and a local server) serve the same pages, and a crawler that
 * finds them should not weigh them against warden.co.nz. Railway's proxy hands the app an `http://` URL on the
 * public hostname, so only the hostname counts.
 */
export function hostRobotsTag(request: Request): "noindex" | undefined {
	return new URL(request.url).hostname === new URL(siteUrl).hostname ? undefined : "noindex";
}

const compressible = /^(text\/|application\/(json|xml|javascript)|image\/svg\+xml)/i;
const minBytes = 1024;

/** Whether a response of this content type/size/state should be gzipped for a client sending `acceptEncoding`. */
export function shouldCompress(input: {
	acceptEncoding: string | null;
	contentType: string | null;
	contentEncoding: string | null;
	contentLength: number | null;
	hasBody: boolean;
}): boolean {
	if (!input.hasBody || input.contentEncoding) return false;
	if (!input.acceptEncoding || !/\bgzip\b/i.test(input.acceptEncoding)) return false;
	if (!input.contentType || !compressible.test(input.contentType)) return false;
	return input.contentLength === null || input.contentLength >= minBytes;
}

/** Gzip a dynamic response (SSR HTML, markdown, search JSON) that nitro's bun preset leaves raw. */
export function compressResponse(request: Request, response: Response): Response {
	const ok = shouldCompress({
		acceptEncoding: request.headers.get("accept-encoding"),
		contentType: response.headers.get("content-type"),
		contentEncoding: response.headers.get("content-encoding"),
		contentLength: response.headers.has("content-length") ? Number(response.headers.get("content-length")) : null,
		hasBody: request.method !== "HEAD" && response.body !== null && response.status !== 204 && response.status !== 304,
	});
	if (!ok || !response.body) return response;

	const headers = new Headers(response.headers);
	headers.set("Content-Encoding", "gzip");
	headers.delete("Content-Length");
	headers.append("Vary", "Accept-Encoding");
	return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
