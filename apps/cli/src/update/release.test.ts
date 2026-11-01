import { describe, expect, test } from "bun:test";
import { updateRelease } from "./release";

const VIEW = JSON.stringify({
	tagName: "v0.3.0",
	assets: [
		{ name: "warden-darwin-arm64", size: 10 },
		{ name: "warden-darwin-x64", size: 11 },
		{ name: "checksums.txt", size: 1 },
	],
});

describe("release", () => {
	test("assetName per os/arch", () => {
		expect(updateRelease.assetName("darwin", "arm64")).toEqual({ success: true, data: "warden-darwin-arm64" });
		expect(updateRelease.assetName("linux", "x64")).toEqual({ success: true, data: "warden-linux-x64" });
		expect(updateRelease.assetName("win32", "x64").success).toBe(false);
	});

	test("parseReleaseView", () => {
		expect(updateRelease.parseReleaseView(VIEW)).toEqual({
			success: true,
			data: { tag: "v0.3.0", version: "0.3.0", assets: ["warden-darwin-arm64", "warden-darwin-x64", "checksums.txt"] },
		});
		expect(updateRelease.parseReleaseView("{}").success).toBe(false);
		expect(updateRelease.parseReleaseView("nope").success).toBe(false);
	});

	test("pickAsset needs binary + checksums", () => {
		const release = { tag: "v0.3.0", version: "0.3.0", assets: ["warden-darwin-arm64", "checksums.txt"] };
		expect(updateRelease.pickAsset(release, "warden-darwin-arm64").success).toBe(true);
		expect(updateRelease.pickAsset(release, "warden-linux-x64").success).toBe(false);
		expect(
			updateRelease.pickAsset({ ...release, assets: ["warden-darwin-arm64"] }, "warden-darwin-arm64").success
		).toBe(false);
	});

	test("parseChecksums (sha256sum format)", () => {
		const text = "aa11  warden-darwin-arm64\nbb22 *warden-linux-x64\n\n";
		expect(updateRelease.parseChecksums(text)).toEqual(
			new Map([
				["warden-darwin-arm64", "aa11"],
				["warden-linux-x64", "bb22"],
			])
		);
	});

	test("releaseRepo default + override", () => {
		expect(updateRelease.releaseRepo({})).toBe("delacournz/warden");
		expect(updateRelease.releaseRepo({ WARDEN_RELEASE_REPO: "me/fork" })).toBe("me/fork");
	});

	test("latestRelease: no release yet → clear message", async () => {
		const result = await updateRelease.latestRelease(
			async () => ({ exitCode: 1, stdout: "", stderr: "release not found" }),
			"o/r"
		);
		expect(result).toEqual({ success: false, error: "no release published on o/r yet" });
	});
});
