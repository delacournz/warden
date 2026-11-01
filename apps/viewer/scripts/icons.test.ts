import { describe, expect, test } from "bun:test";
import { BRAND_ICON_PATH, iconFiles, parseArgs, resolveSource, sourceHash } from "./icons";

describe("iconFiles", () => {
	test("is every bundle.icon basename plus icon.png, deduped", () => {
		const conf = { bundle: { icon: ["icons/32x32.png", "icons/icon.icns", "icons/icon.png"] } };
		expect(iconFiles(conf)).toEqual(["32x32.png", "icon.icns", "icon.png"]);
	});

	test("adds icon.png when bundle.icon omits it", () => {
		expect(iconFiles({ bundle: { icon: ["icons/icon.ico"] } })).toEqual(["icon.ico", "icon.png"]);
	});

	test("rejects a conf without bundle.icon", () => {
		expect(() => iconFiles({})).toThrow("bundle.icon");
	});
});

describe("parseArgs", () => {
	test("takes a positional source and --ref", () => {
		expect(parseArgs(["/x/icon.png", "--ref", "main"])).toEqual({ source: "/x/icon.png", ref: "main", force: false });
	});

	test("defaults ref to develop", () => {
		expect(parseArgs([])).toEqual({ source: undefined, ref: "develop", force: false });
	});
});

describe("resolveSource", () => {
	test("a .png argument is used as is", () => {
		expect(resolveSource({ source: "/a/b.png", ref: "develop", force: false }, {})).toEqual({
			kind: "file",
			path: "/a/b.png",
		});
	});

	test("a directory argument is a brand package dir", () => {
		expect(resolveSource({ source: "/brand", ref: "develop", force: false }, {})).toEqual({
			kind: "file",
			path: `/brand/${BRAND_ICON_PATH}`,
		});
	});

	test("WARDEN_BRAND_DIR is the fallback", () => {
		expect(resolveSource({ source: undefined, ref: "develop", force: false }, { WARDEN_BRAND_DIR: "/brand" })).toEqual({
			kind: "file",
			path: `/brand/${BRAND_ICON_PATH}`,
		});
	});

	test("otherwise fetches from GitHub at the ref", () => {
		expect(resolveSource({ source: undefined, ref: "main", force: false }, {})).toEqual({
			kind: "github",
			ref: "main",
		});
	});
});

describe("parseArgs --force", () => {
	test("sets force", () => {
		expect(parseArgs(["--force"])).toEqual({ source: undefined, ref: "develop", force: true });
	});
});

describe("sourceHash", () => {
	test("is the sha256 hex of the master png", () => {
		expect(sourceHash(new TextEncoder().encode("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
		);
	});
});
