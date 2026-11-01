import { describe, expect, test } from "bun:test";
import { HELPER_ASSET, npmHelper } from "./helper";

describe("parseHelperManifest", () => {
	test("keeps version/idb/xcode, drops builtAt", () => {
		expect(
			npmHelper.parseHelperManifest(
				JSON.stringify({ version: "0.1.0", idb: "1.1.8", xcode: "26.6 (17F113)", builtAt: "2026-10-16T00:00:00Z" })
			)
		).toEqual({ success: true, data: { version: "0.1.0", idb: "1.1.8", xcode: "26.6 (17F113)" } });
	});

	test("rejects non-JSON, non-objects and missing fields", () => {
		expect(npmHelper.parseHelperManifest("nope").success).toBe(false);
		expect(npmHelper.parseHelperManifest("[]").success).toBe(false);
		expect(npmHelper.parseHelperManifest(JSON.stringify({ version: "1", idb: "2" })).success).toBe(false);
		expect(npmHelper.parseHelperManifest(JSON.stringify({ version: 1, idb: "2", xcode: "3" })).success).toBe(false);
	});
});

describe("helper layout", () => {
	test("asset name and staged files", () => {
		expect(HELPER_ASSET).toBe("warden-simd-darwin-arm64.tgz");
		expect(npmHelper.helperFiles("bin", ["A.framework", "B.framework"])).toEqual([
			"bin/warden-simd",
			"bin/Resources",
			"bin/manifest.json",
			"bin/A.framework",
			"bin/B.framework",
		]);
		expect(npmHelper.helperFiles("bin", ["A.framework"], true).at(-1)).toBe("bin/libwarden-inject.dylib");
	});
});
