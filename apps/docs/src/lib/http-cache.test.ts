import { describe, expect, test } from "bun:test";
import { compressResponse, routeRules, shouldCompress } from "./http-cache";

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
	test("pages are edge-cacheable with stale-while-revalidate; the demo video is cached", () => {
		expect(routeRules["/docs/**"].headers["Cache-Control"]).toContain("stale-while-revalidate");
		expect(routeRules["/docs/**"].headers["Cache-Control"]).toContain("s-maxage");
		expect(routeRules["/demo/**"].headers["Cache-Control"]).toContain("max-age=86400");
	});
});
