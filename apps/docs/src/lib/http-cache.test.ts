import { describe, expect, test } from "bun:test";
import { compressResponse, hostRobotsTag, routeRules, shouldCompress } from "./http-cache";

const base = {
	acceptEncoding: "gzip, br",
	contentType: "text/html; charset=utf-8",
	contentEncoding: null,
	contentLength: null,
	hasBody: true,
};

describe("shouldCompress", () => {
	test("gzips text when the client accepts it", () => {
		expect(shouldCompress(base)).toBe(true);
	});
	test("skips clients without gzip, binary, already-encoded, tiny and bodiless responses", () => {
		expect(shouldCompress({ ...base, acceptEncoding: "identity" })).toBe(false);
		expect(shouldCompress({ ...base, acceptEncoding: null })).toBe(false);
		expect(shouldCompress({ ...base, contentType: "video/webm" })).toBe(false);
		expect(shouldCompress({ ...base, contentEncoding: "br" })).toBe(false);
		expect(shouldCompress({ ...base, contentLength: 100 })).toBe(false);
		expect(shouldCompress({ ...base, hasBody: false })).toBe(false);
	});
});

describe("compressResponse", () => {
	test("round-trips a gzipped body and sets headers", async () => {
		const text = "hello ".repeat(1000);
		const req = new Request("http://x/", { headers: { "accept-encoding": "gzip" } });
		const res = compressResponse(req, new Response(text, { headers: { "content-type": "text/html" } }));
		expect(res.headers.get("content-encoding")).toBe("gzip");
		expect(res.headers.get("vary")).toContain("Accept-Encoding");
		const back = await new Response(res.body?.pipeThrough(new DecompressionStream("gzip"))).text();
		expect(back).toBe(text);
	});
	test("leaves HEAD and non-text untouched", () => {
		const head = new Request("http://x/", { method: "HEAD", headers: { "accept-encoding": "gzip" } });
		const res = new Response("x".repeat(2000), { headers: { "content-type": "text/html" } });
		expect(compressResponse(head, res)).toBe(res);
	});
});

describe("routeRules", () => {
	test("pages are edge-cacheable with stale-while-revalidate; demo videos are cached", () => {
		expect(routeRules["/docs/**"].headers["Cache-Control"]).toContain("stale-while-revalidate");
		expect(routeRules["/docs/**"].headers["Cache-Control"]).toContain("s-maxage");
		expect(routeRules["/demos/**"].headers["Cache-Control"]).toContain("max-age=86400");
	});

	test("the sitemap is cached like robots.txt", () => {
		expect(routeRules["/sitemap.xml"].headers["Cache-Control"]).toBe(
			routeRules["/robots.txt"].headers["Cache-Control"]
		);
	});

	test("raw bench artifacts and the llms files stay out of the search index", () => {
		expect(routeRules["/bench/**"].headers["X-Robots-Tag"]).toBe("noindex");
		expect(routeRules["/llms.txt"].headers["X-Robots-Tag"]).toBe("noindex");
		expect(routeRules["/llms-full.txt"].headers["X-Robots-Tag"]).toBe("noindex");
	});

	test("every response carries the security headers, and they never override a route's own", () => {
		const all = routeRules["/**"].headers;
		expect(all["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
		expect(all["X-Content-Type-Options"]).toBe("nosniff");
		expect(all["X-Frame-Options"]).toBe("SAMEORIGIN");
		expect(all["Content-Security-Policy"]).toBe("frame-ancestors 'self'");
		expect(all["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
		expect(all["Permissions-Policy"]).toContain("camera=()");
		expect("Cache-Control" in all).toBe(false);
		expect("X-Robots-Tag" in all).toBe(false);
	});
});

describe("hostRobotsTag", () => {
	test("keeps every host but production out of the index", () => {
		expect(hostRobotsTag(new Request("https://staging.warden.co.nz/docs/e2e"))).toBe("noindex");
		expect(hostRobotsTag(new Request("http://localhost:3210/"))).toBe("noindex");
	});

	test("production, behind Railway's http proxy too, is indexable", () => {
		expect(hostRobotsTag(new Request("https://warden.co.nz/docs/e2e"))).toBeUndefined();
		expect(hostRobotsTag(new Request("http://warden.co.nz/docs/e2e"))).toBeUndefined();
	});
});

describe("docs pages vary on Accept", () => {
	test("the edge never hands a cached HTML page to a client asking for Markdown", () => {
		expect(routeRules["/docs/**"].headers.Vary).toBe("Accept");
	});
});
