import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHelperDist } from "./helper.testing";
import { stageHelper } from "./helper-stage";

let root: string;
let dist: string;
let bin: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "warden-helper-stage-"));
	dist = join(root, "dist");
	bin = join(root, "pkg", "bin");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stageHelper", () => {
	test("copies binary, resources, manifest and every framework into bin/", () => {
		fakeHelperDist(dist);
		const staged = stageHelper({ distDir: dist, binDir: bin, required: false });
		expect(staged).toEqual({
			success: true,
			data: {
				version: "0.1.0",
				idb: "1.1.8",
				xcode: "26.6 (17F113)",
				frameworks: ["AccessibilityPlatformTranslationStub.framework", "CoreSimulatorStub.framework"],
				inject: false,
			},
		});
		for (const path of [
			"warden-simd",
			"Resources/SimulatorFrameworkBridge-iOS",
			"manifest.json",
			"CoreSimulatorStub.framework/Info.plist",
			"AccessibilityPlatformTranslationStub.framework/Info.plist",
		]) {
			expect(existsSync(join(bin, path))).toBe(true);
		}
		expect(statSync(join(bin, "warden-simd")).mode & 0o111).toBe(0o111);
	});

	test("the injected dylib is staged when built, and a release build requires it", () => {
		fakeHelperDist(dist, { inject: true });
		const staged = stageHelper({ distDir: dist, binDir: bin, required: true });
		expect(staged.success && staged.data?.inject).toBe(true);
		expect(existsSync(join(bin, "libwarden-inject.dylib"))).toBe(true);

		const bare = join(root, "bare");
		fakeHelperDist(bare);
		const missing = stageHelper({ distDir: bare, binDir: join(root, "pkg2", "bin"), required: true });
		expect(missing.success).toBe(false);
		if (!missing.success) expect(missing.error).toContain("libwarden-inject.dylib");
		expect(stageHelper({ distDir: bare, binDir: join(root, "pkg3", "bin"), required: false }).success).toBe(true);
	});

	test("no helper built: skipped, unless required", () => {
		expect(stageHelper({ distDir: dist, binDir: bin, required: false })).toEqual({ success: true, data: undefined });
		const required = stageHelper({ distDir: dist, binDir: bin, required: true });
		expect(required.success).toBe(false);
		if (!required.success) expect(required.error).toContain("--require-helper");
		expect(existsSync(bin)).toBe(false);
	});

	test.each([
		["guest", { guest: false }, "SimulatorFrameworkBridge-iOS"],
		["manifest", { manifest: false }, "manifest.json"],
		["frameworks", { frameworks: [] }, "*.framework"],
	])("incomplete dist (missing %s) is an error even when not required", (_name, opts, message) => {
		fakeHelperDist(dist, opts);
		const staged = stageHelper({ distDir: dist, binDir: bin, required: false });
		expect(staged.success).toBe(false);
		if (!staged.success) expect(staged.error).toContain(message);
		expect(existsSync(bin)).toBe(false);
	});
});
