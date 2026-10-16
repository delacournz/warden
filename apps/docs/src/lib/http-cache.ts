/** Edge-cacheable page policy: browsers revalidate, Railway's edge may serve a shared copy for 5 min then stale for a day. */
const pageCache = "public, max-age=0, s-maxage=300, stale-while-revalidate=86400";

/** Static public files that are not content-hashed: a day in browsers, a week at the edge. */
const staticCache = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";

/** Nitro `routeRules`: Cache-Control per route family. Hashed `/assets/**` already ship `immutable` from nitro. */
export const routeRules = {
	"/": { headers: { "Cache-Control": pageCache } },
	"/docs/**": { headers: { "Cache-Control": pageCache } },
	"/llms.txt": { headers: { "Cache-Control": pageCache } },
	"/llms-full.txt": { headers: { "Cache-Control": pageCache } },
	"/robots.txt": { headers: { "Cache-Control": staticCache } },
	"/demo/**": { headers: { "Cache-Control": staticCache } },
	"/og/**": { headers: { "Cache-Control": staticCache } },
	"/favicon.svg": { headers: { "Cache-Control": staticCache } },
} as const;

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
