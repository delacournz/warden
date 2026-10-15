import { describe, expect, test } from "bun:test";
import { e2eManifest, mainManifest, type PackageMeta, platformManifest } from "./manifests";
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

describe("platformManifest with the simulator helper", () => {
	const helper = { version: "0.1.0", idb: "1.1.8", xcode: "26.6 (17F113)", frameworks: ["A.framework", "B.framework"] };

	test("darwin-arm64 ships warden-simd, resources, frameworks and records the build for doctor", () => {
		const manifest = platformManifest("darwin-arm64", meta, helper);
		expect(manifest.files).toEqual([
			"bin/warden",
			"bin/warden-simd",
			"bin/Resources",
			"bin/manifest.json",
			"bin/A.framework",
			"bin/B.framework",
			"LICENSE",
		]);
		expect(manifest.bin).toEqual({ "warden-simd": "bin/warden-simd" });
		expect(manifest.warden).toEqual({ helper: { version: "0.1.0", idb: "1.1.8", xcode: "26.6 (17F113)" } });
	});

	test("without a staged helper, darwin-arm64 is the plain binary package", () => {
		const manifest = platformManifest("darwin-arm64", meta);
		expect(manifest.files).toEqual(["bin/warden", "LICENSE"]);
		expect("bin" in manifest).toBe(false);
		expect("warden" in manifest).toBe(false);
	});

	test("other targets are unchanged even when a helper is passed", () => {
		for (const target of ["darwin-x64", "linux-arm64", "linux-x64"] as const) {
			expect(platformManifest(target, meta, helper)).toEqual(platformManifest(target, meta));
		}
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

describe("e2eManifest", () => {
	test("public lock-step package: exact-version peer on warden, only `.` and `./preload` exported", () => {
		expect(e2eManifest(meta, { zod: "^4.4.3" })).toEqual({
			name: "@delacour/warden-e2e",
			version: "0.3.0",
			description: "TypeScript spec API for `warden e2e`: test, expect, screen, device, app",
			license: "MIT",
			type: "module",
			keywords: ["e2e", "ios-simulator", "android-emulator", "bun", "testing"],
			exports: {
				".": { types: "./index.d.ts", default: "./index.mjs" },
				"./preload": { types: "./preload.d.ts", default: "./preload.mjs" },
				"./package.json": "./package.json",
			},
			files: ["*.mjs", "*.d.ts", "types", "LICENSE"],
			peerDependencies: { "@delacour/warden": "0.3.0" },
			dependencies: { zod: "^4.4.3" },
			engines: { bun: ">=1.3" },
			publishConfig: { access: "public" },
		});
	});

	test("no workspace-private dependency leaks into the published manifest; repo links only with a repository", () => {
		const manifest = e2eManifest(withRepo, { zod: "^4.4.3" });
		expect(JSON.stringify(manifest)).not.toContain("workspace:");
		expect(Object.keys(manifest.dependencies)).toEqual(["zod"]);
		expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/delacournz/warden.git" });
		expect("repository" in e2eManifest(meta, {})).toBe(false);
	});
});
