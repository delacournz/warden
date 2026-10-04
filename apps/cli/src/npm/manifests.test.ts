import { describe, expect, test } from "bun:test";
import { mainManifest, type PackageMeta, platformManifest } from "./manifests";
import { RELEASE_TARGETS } from "./platforms";

const meta: PackageMeta = { version: "0.3.0", description: "warden CLI", license: "MIT" };
const withRepo: PackageMeta = { ...meta, repository: "delacournz/warden" };

describe("platformManifest", () => {
	test("pins os/cpu, ships the binary + LICENSE, publishes publicly", () => {
		expect(platformManifest("linux-arm64", meta)).toEqual({
			name: "@delacour/warden-linux-arm64",
			version: "0.3.0",
			description: "The linux-arm64 binary for @delacour/warden",
			license: "MIT",
			os: ["linux"],
			cpu: ["arm64"],
			files: ["bin/warden", "LICENSE"],
			preferUnplugged: true,
			publishConfig: { access: "public" },
		});
	});

	test("repo links only when a repository is given", () => {
		expect(platformManifest("linux-arm64", withRepo)).toMatchObject({
			repository: { type: "git", url: "git+https://github.com/delacournz/warden.git" },
			homepage: "https://github.com/delacournz/warden#readme",
			bugs: { url: "https://github.com/delacournz/warden/issues" },
		});
	});
});

describe("mainManifest", () => {
	test("warden bin → JS shim, every platform an exact-version optionalDependency", () => {
		const manifest = mainManifest(meta);
		expect(manifest.name).toBe("@delacour/warden");
		expect(manifest.license).toBe("MIT");
		expect(manifest.bin).toEqual({ warden: "bin/warden.mjs" });
		expect(manifest.files).toEqual(["bin/warden.mjs", "config/index.mjs", "config/index.d.ts", "README.md", "LICENSE"]);
		expect(manifest.exports["./config"]).toEqual({ types: "./config/index.d.ts", default: "./config/index.mjs" });
		expect(manifest.publishConfig).toEqual({ access: "public" });
		expect(Object.keys(manifest.optionalDependencies)).toEqual(
			RELEASE_TARGETS.map((target) => `@delacour/warden-${target}`)
		);
		expect(new Set(Object.values(manifest.optionalDependencies))).toEqual(new Set(["0.3.0"]));
		expect("dependencies" in manifest).toBe(false);
	});

	test("private repo (no repository) → no repository / homepage / bugs", () => {
		const manifest = mainManifest(meta);
		expect("repository" in manifest).toBe(false);
		expect("homepage" in manifest).toBe(false);
		expect("bugs" in manifest).toBe(false);
		expect(mainManifest(withRepo)).toMatchObject({
			repository: { type: "git", url: "git+https://github.com/delacournz/warden.git" },
			homepage: "https://github.com/delacournz/warden#readme",
			bugs: { url: "https://github.com/delacournz/warden/issues" },
		});
	});
});
