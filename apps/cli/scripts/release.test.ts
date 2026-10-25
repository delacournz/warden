import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	applyVersion,
	isNpmOtpError,
	npmOtp,
	publishPackageDirs,
	releasePackageNames,
	releasePlan,
	releaseVersion,
	VERSION_FILES,
	withPackageVersion,
} from "./release";

describe("releaseVersion", () => {
	test("accepts a semver and strips a leading v", () => {
		expect(releaseVersion("0.2.0")).toBe("0.2.0");
		expect(releaseVersion("v1.2.3")).toBe("1.2.3");
		expect(releaseVersion("1.0.0-rc.2")).toBe("1.0.0-rc.2");
	});

	test("rejects anything that is not a version", () => {
		expect(releaseVersion("1.2")).toBeUndefined();
		expect(releaseVersion("latest")).toBeUndefined();
		expect(releaseVersion("")).toBeUndefined();
	});
});

describe("npmOtp", () => {
	test("keeps a 6 to 8 digit authenticator code", () => {
		expect(npmOtp("123456")).toBe("123456");
		expect(npmOtp(" 12345678 ")).toBe("12345678");
	});

	test("rejects anything else", () => {
		expect(() => npmOtp("12345")).toThrow("one-time password");
		expect(() => npmOtp("abcdef")).toThrow("one-time password");
	});

	test("recognises npm's EOTP failure", () => {
		expect(isNpmOtpError("npm error code EOTP")).toBe(true);
		expect(isNpmOtpError("npm error This operation requires a one-time password")).toBe(true);
		expect(isNpmOtpError("npm error code E404")).toBe(false);
	});
});

describe("withPackageVersion", () => {
	test("rewrites the top-level version and leaves other version fields", () => {
		const source = `{
	"name": "@delacour/warden",
	"version": "0.1.0",
	"dependencies": { "left": "1.0.0" }
}
`;
		expect(withPackageVersion(source, "0.2.0")).toBe(`{
	"name": "@delacour/warden",
	"version": "0.2.0",
	"dependencies": { "left": "1.0.0" }
}
`);
	});

	test("throws when there is no version field", () => {
		expect(() => withPackageVersion(`{ "name": "x" }\n`, "0.2.0")).toThrow("no version field");
	});
});

describe("applyVersion", () => {
	test("writes the version once and reports no change the second time", () => {
		const root = mkdtempSync(join(tmpdir(), "warden-release-"));
		try {
			for (const file of VERSION_FILES) {
				const path = join(root, file);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `{ "version": "0.1.0" }\n`);
			}
			expect(applyVersion(root, "0.2.0")).toEqual([...VERSION_FILES]);
			expect(applyVersion(root, "0.2.0")).toEqual([]);
			expect(readFileSync(join(root, VERSION_FILES[0] ?? ""), "utf8")).toContain('"version": "0.2.0"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("publish layout", () => {
	test("version files are the cli and e2e manifests", () => {
		expect(VERSION_FILES).toEqual(["apps/cli/package.json", "packages/e2e/package.json"]);
	});

	test("platform packages publish before warden, and warden-e2e last", () => {
		const dirs = publishPackageDirs("/dist/npm");
		expect(dirs.slice(0, 4)).toEqual([
			join("/dist/npm", "warden-darwin-arm64"),
			join("/dist/npm", "warden-darwin-x64"),
			join("/dist/npm", "warden-linux-arm64"),
			join("/dist/npm", "warden-linux-x64"),
		]);
		expect(dirs.at(-2)).toBe(join("/dist/npm", "warden"));
		expect(dirs.at(-1)).toBe(join("/dist/npm", "warden-e2e"));
	});
});

describe("releasePlan", () => {
	test("lists every package in publish order", () => {
		expect(releasePackageNames()).toEqual([
			"@delacour/warden-darwin-arm64",
			"@delacour/warden-darwin-x64",
			"@delacour/warden-linux-arm64",
			"@delacour/warden-linux-x64",
			"@delacour/warden",
			"@delacour/warden-e2e",
		]);
	});

	test("is done when every package is already on npm", () => {
		const names = ["@delacour/warden-darwin-arm64", "@delacour/warden"];
		expect(releasePlan(names, new Set(names))).toEqual({ kind: "done" });
	});

	test("publishes everything when nothing is on npm", () => {
		const names = ["@delacour/warden-darwin-arm64", "@delacour/warden"];
		expect(releasePlan(names, new Set())).toEqual({ kind: "publish", pending: names, skipped: [] });
	});

	test("skips the packages already on npm and keeps the rest in order", () => {
		const names = ["@delacour/warden-darwin-arm64", "@delacour/warden-darwin-x64", "@delacour/warden"];
		expect(releasePlan(names, new Set(["@delacour/warden-darwin-x64"]))).toEqual({
			kind: "publish",
			pending: ["@delacour/warden-darwin-arm64", "@delacour/warden"],
			skipped: ["@delacour/warden-darwin-x64"],
		});
	});
});
