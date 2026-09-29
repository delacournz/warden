import { describe, expect, test } from "bun:test";
import { assetName, latestRelease, parseChecksums, parseReleaseView, pickAsset, releaseRepo } from "./release";

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
		expect(assetName("darwin", "arm64")).toEqual({ success: true, data: "warden-darwin-arm64" });
		expect(assetName("linux", "x64")).toEqual({ success: true, data: "warden-linux-x64" });
		expect(assetName("win32", "x64").success).toBe(false);
	});

	test("parseReleaseView", () => {
		expect(parseReleaseView(VIEW)).toEqual({
			success: true,
			data: { tag: "v0.3.0", version: "0.3.0", assets: ["warden-darwin-arm64", "warden-darwin-x64", "checksums.txt"] },
		});
		expect(parseReleaseView("{}").success).toBe(false);
		expect(parseReleaseView("nope").success).toBe(false);
	});

	test("pickAsset needs binary + checksums", () => {
		const release = { tag: "v0.3.0", version: "0.3.0", assets: ["warden-darwin-arm64", "checksums.txt"] };
		expect(pickAsset(release, "warden-darwin-arm64").success).toBe(true);
		expect(pickAsset(release, "warden-linux-x64").success).toBe(false);
		expect(pickAsset({ ...release, assets: ["warden-darwin-arm64"] }, "warden-darwin-arm64").success).toBe(false);
	});

	test("parseChecksums (sha256sum format)", () => {
		const text = "aa11  warden-darwin-arm64\nbb22 *warden-linux-x64\n\n";
		expect(parseChecksums(text)).toEqual(
			new Map([
				["warden-darwin-arm64", "aa11"],
				["warden-linux-x64", "bb22"],
			])
		);
	});

	test("releaseRepo default + override", () => {
		expect(releaseRepo({})).toBe("delacournz/warden");
		expect(releaseRepo({ WARDEN_RELEASE_REPO: "me/fork" })).toBe("me/fork");
	});

	test("latestRelease: no release yet → clear message", async () => {
		const result = await latestRelease(async () => ({ exitCode: 1, stdout: "", stderr: "release not found" }), "o/r");
		expect(result).toEqual({ success: false, error: "no release published on o/r yet" });
	});
});
