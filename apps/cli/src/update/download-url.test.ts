import { describe, expect, test } from "bun:test";
import { checkDownloadUrl, sameOrigin } from "./download-url";

describe("checkDownloadUrl", () => {
	test("https, loopback http and file URLs pass", () => {
		for (const url of [
			"https://mirror.example/h",
			"http://127.0.0.1:4873",
			"http://localhost:9/h",
			"http://[::1]:9/h",
			"file:///tmp/dist",
		]) {
			expect(checkDownloadUrl(url, "WARDEN_HELPER_URL")).toEqual({ success: true, data: url });
		}
	});

	test("anything else is refused, naming the variable and the value", () => {
		for (const url of [
			"http://mirror.example/h",
			"http://localhost.example/h",
			"http://127.0.0.1.example/h",
			"ftp://mirror.example/h",
			"data:text/plain,hi",
			"mirror.example/h",
			"",
		]) {
			const result = checkDownloadUrl(url, "WARDEN_HELPER_URL");
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("WARDEN_HELPER_URL");
				expect(result.error).toContain("https:");
				expect(result.error).toContain(JSON.stringify(url));
			}
		}
	});
});

describe("sameOrigin", () => {
	test("scheme, host and port must all match", () => {
		expect(sameOrigin("https://registry.npmjs.org/a/-/a-1.tgz", "https://registry.npmjs.org")).toBe(true);
		expect(sameOrigin("http://127.0.0.1:4873/a.tgz", "http://127.0.0.1:4873")).toBe(true);
		expect(sameOrigin("https://cdn.example/a.tgz", "https://registry.npmjs.org")).toBe(false);
		expect(sameOrigin("http://registry.npmjs.org/a.tgz", "https://registry.npmjs.org")).toBe(false);
		expect(sameOrigin("https://registry.npmjs.org:8443/a.tgz", "https://registry.npmjs.org")).toBe(false);
		expect(sameOrigin("https://registry.npmjs.org.evil.example/a.tgz", "https://registry.npmjs.org")).toBe(false);
		expect(sameOrigin("not a url", "https://registry.npmjs.org")).toBe(false);
	});
});
