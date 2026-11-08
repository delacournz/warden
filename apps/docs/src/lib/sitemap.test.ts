import { describe, expect, test } from "bun:test";
import { sitemapPaths, sitemapXml } from "./sitemap";

describe("sitemapPaths", () => {
	test("home, every docs page and the privacy policy, once each", () => {
		expect(sitemapPaths(["/docs", "/docs/e2e", "/docs/e2e"])).toEqual(["/", "/docs", "/docs/e2e", "/privacy"]);
	});
});

describe("sitemapXml", () => {
	test("absolute locs on the production host, no invented lastmod", () => {
		const xml = sitemapXml(["/", "/docs/e2e"]);
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
		expect(xml).toContain("<url><loc>https://warden.co.nz/</loc></url>");
		expect(xml).toContain("<url><loc>https://warden.co.nz/docs/e2e</loc></url>");
		expect(xml).not.toContain("lastmod");
	});

	test("escapes XML in a path", () => {
		expect(sitemapXml(["/a&b"])).toContain("<loc>https://warden.co.nz/a&amp;b</loc>");
	});
});
