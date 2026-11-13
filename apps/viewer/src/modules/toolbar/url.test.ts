import { describe, expect, test } from "bun:test";
import { normalizeUrl } from "./url.ts";

describe("normalizeUrl", () => {
	test("keeps anything with a scheme separator", () => {
		expect(normalizeUrl("https://example.com/a")).toBe("https://example.com/a");
		expect(normalizeUrl("myapp://deep/link?x=1")).toBe("myapp://deep/link?x=1");
	});

	test("prefixes https for a bare host, including host:port", () => {
		expect(normalizeUrl("example.com")).toBe("https://example.com");
		expect(normalizeUrl("localhost:3000/x")).toBe("https://localhost:3000/x");
	});

	test("trims and rejects empty input", () => {
		expect(normalizeUrl("  example.com  ")).toBe("https://example.com");
		expect(normalizeUrl("   ")).toBeNull();
	});

	test("rejects text with spaces", () => {
		expect(normalizeUrl("not a url")).toBeNull();
	});
});
