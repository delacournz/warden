import { describe, expect, test } from "bun:test";
import { isBundleUrl, toNormalBundleUrl } from "./bundle-url";

const JSC_SAFE = "http://127.0.0.1:8082/apps/example/index.ts.bundle//&platform=ios&dev=true&lazy=true";

describe("isBundleUrl", () => {
	test("a Metro bundle in plain or JSC-safe (`//&`) form, over http", () => {
		expect(isBundleUrl("http://localhost:8081/index.bundle?platform=ios")).toBe(true);
		expect(isBundleUrl("http://localhost:8081/index.bundle")).toBe(true);
		expect(isBundleUrl(JSC_SAFE)).toBe(true);
	});

	test("anything else is not", () => {
		expect(isBundleUrl("http://localhost:8081/index.map?platform=ios")).toBe(false);
		expect(isBundleUrl("file:///app/index.bundle")).toBe(false);
		expect(isBundleUrl("http://localhost:8081/x.bundled")).toBe(false);
		expect(isBundleUrl("InternalBytecode.js")).toBe(false);
	});
});

describe("toNormalBundleUrl", () => {
	test("`//&` becomes `?`, a plain URL is unchanged", () => {
		expect(toNormalBundleUrl(JSC_SAFE)).toBe(
			"http://127.0.0.1:8082/apps/example/index.ts.bundle?platform=ios&dev=true&lazy=true"
		);
		expect(toNormalBundleUrl("http://h/index.bundle?platform=ios")).toBe("http://h/index.bundle?platform=ios");
	});
});
