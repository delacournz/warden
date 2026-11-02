import { describe, expect, test } from "bun:test";
import { assetName, bundleCandidates, rustTriple, stagedEntry, VIEWER_TARGETS } from "./pack-asset";

describe("rustTriple", () => {
	test("maps every target", () => {
		expect(rustTriple("darwin-arm64")).toBe("aarch64-apple-darwin");
		expect(rustTriple("darwin-x64")).toBe("x86_64-apple-darwin");
		expect(rustTriple("win32-x64")).toBe("x86_64-pc-windows-msvc");
	});
});

describe("assetName", () => {
	test("is a .tgz for every target, windows included", () => {
		for (const target of VIEWER_TARGETS) expect(assetName(target)).toBe(`warden-viewer-${target}.tgz`);
	});
});

describe("stagedEntry", () => {
	test("is the archive-root entry the CLI resolves", () => {
		expect(stagedEntry("darwin-arm64")).toBe("warden viewer.app");
		expect(stagedEntry("darwin-x64")).toBe("warden viewer.app");
		expect(stagedEntry("win32-x64")).toBe("warden-viewer.exe");
	});
});

describe("bundleCandidates", () => {
	test("prefers the triple-scoped output of a cross build, then the host build", () => {
		expect(bundleCandidates("darwin-x64", "release")).toEqual([
			"src-tauri/target/x86_64-apple-darwin/release/bundle/macos/warden viewer.app",
			"src-tauri/target/release/bundle/macos/warden viewer.app",
		]);
	});

	test("windows points at the bare exe", () => {
		expect(bundleCandidates("win32-x64", "release")).toEqual([
			"src-tauri/target/x86_64-pc-windows-msvc/release/warden-viewer.exe",
			"src-tauri/target/release/warden-viewer.exe",
		]);
	});

	test("honours the profile", () => {
		expect(bundleCandidates("darwin-arm64", "debug")[1]).toBe("src-tauri/target/debug/bundle/macos/warden viewer.app");
	});
});
