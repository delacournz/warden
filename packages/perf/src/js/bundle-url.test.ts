import { describe, expect, test } from "bun:test";
import { bundleUrls } from "./bundle-url";

const JSC_SAFE = "http://127.0.0.1:8082/apps/example/index.ts.bundle//&platform=ios&dev=true&lazy=true";

describe("isBundleUrl", () => {
	test("a Metro bundle in plain or JSC-safe (`//&`) form, over http", () => {
		expect(bundleUrls.isBundleUrl("http://localhost:8081/index.bundle?platform=ios")).toBe(true);
		expect(bundleUrls.isBundleUrl("http://localhost:8081/index.bundle")).toBe(true);
		expect(bundleUrls.isBundleUrl(JSC_SAFE)).toBe(true);
	});

	test("anything else is not", () => {
		expect(bundleUrls.isBundleUrl("http://localhost:8081/index.map?platform=ios")).toBe(false);
		expect(bundleUrls.isBundleUrl("file:///app/index.bundle")).toBe(false);
		expect(bundleUrls.isBundleUrl("http://localhost:8081/x.bundled")).toBe(false);
		expect(bundleUrls.isBundleUrl("InternalBytecode.js")).toBe(false);
	});
});

describe("toNormalBundleUrl", () => {
	test("`//&` becomes `?`, a plain URL is unchanged", () => {
		expect(bundleUrls.toNormalBundleUrl(JSC_SAFE)).toBe(
			"http://127.0.0.1:8082/apps/example/index.ts.bundle?platform=ios&dev=true&lazy=true"
		);
		expect(bundleUrls.toNormalBundleUrl("http://h/index.bundle?platform=ios")).toBe(
			"http://h/index.bundle?platform=ios"
		);
	});
});
